import { logger } from '@appium/support';
import { expect } from 'chai';

import type { TestmanagerdServiceWithConnection } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { MessageAux } from '../../src/services/ios/dvt/index.js';

const log = logger.getLogger('Testmanagerd.test');
log.level = 'debug';

const XCODE_VERSION = 36;

const UDID = process.env.UDID || '';

const TESTMANAGERD_CHANNEL =
  'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface';

async function safeClose(
  ...closeables: Array<{ close(): Promise<void> } | null | undefined>
): Promise<void> {
  await Promise.allSettled(
    closeables.map((c) => c?.close() ?? Promise.resolve()),
  );
}

/**
 * Run:
 * `UDID=<device-udid> npm run test:testmanagerd`
 */

describe('Testmanagerd Service', function () {
  this.timeout(120000);

  before(function () {
    if (!UDID) {
      throw new Error(
        'Set UDID. Example: UDID=<device-udid> npm run test:testmanagerd',
      );
    }
  });

  describe('Dual-connection handshake + control session init', function () {
    let controlConnection: TestmanagerdServiceWithConnection | null = null;
    let execConnection: TestmanagerdServiceWithConnection | null = null;

    after(async function () {
      await safeClose(
        controlConnection?.testmanagerdService,
        controlConnection?.remoteXPC,
        execConnection?.testmanagerdService,
        execConnection?.remoteXPC,
      );
    });

    it('should connect two independent testmanagerd instances and complete handshakes', async function () {
      controlConnection = await Services.startTestmanagerdService(UDID);
      execConnection = await Services.startTestmanagerdService(UDID);

      expect(controlConnection.testmanagerdService).to.not.be.null;
      expect(execConnection.testmanagerdService).to.not.be.null;

      log.debug('Both testmanagerd connections established');
    });

    it('should create channels on both connections', async function () {
      const controlChannel =
        await controlConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      expect(controlChannel).to.not.be.null;
      expect(controlChannel.getCode()).to.be.greaterThan(0);

      const execChannel =
        await execConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      expect(execChannel).to.not.be.null;
      expect(execChannel.getCode()).to.be.greaterThan(0);

      log.debug(
        `Control channel: ${controlChannel.getCode()}, Exec channel: ${execChannel.getCode()}`,
      );
    });

    it('should initiate control session with protocol version', async function () {
      const controlChannel =
        await controlConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      const channelCode = controlChannel.getCode();

      const args = new MessageAux();
      args.appendObj(XCODE_VERSION);

      await controlConnection!.testmanagerdService.sendMessage(
        channelCode,
        '_IDE_initiateControlSessionWithProtocolVersion:',
        { args },
      );

      const [result] =
        await controlConnection!.testmanagerdService.recvPlist(channelCode);

      log.debug('Control session init result:', result);
      expect(result).to.not.be.null;
    });
  });
});
