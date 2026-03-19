import { logger } from '@appium/support';
import { expect } from 'chai';

import type {
  DVTServiceWithConnection,
  HouseArrestServiceWithConnection,
  TestmanagerdServiceWithConnection,
} from '../../src/index.js';
import { XCTestConfigurationEncoder, runXCTest } from '../../src/index.js';
import {
  createBinaryPlist,
  parseBinaryPlist,
} from '../../src/lib/plist/index.js';
import * as Services from '../../src/services.js';
import { MessageAux } from '../../src/services/ios/dvt/index.js';

const log = logger.getLogger('Testmanagerd.test');
log.level = 'debug';

const XCODE_VERSION = 36;

const UDID = process.env.UDID || '';
const TEST_RUNNER_BUNDLE_ID = process.env.TEST_RUNNER_BUNDLE_ID;
const APP_UNDER_TEST_BUNDLE_ID = process.env.APP_UNDER_TEST_BUNDLE_ID;
const XCTEST_BUNDLE_ID = process.env.XCTEST_BUNDLE_ID;

const TESTMANAGERD_CHANNEL =
  'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface';

type TestmanagerdService =
  TestmanagerdServiceWithConnection['testmanagerdService'];

async function safeClose(
  ...closeables: Array<{ close(): Promise<void> } | null | undefined>
): Promise<void> {
  await Promise.allSettled(
    closeables.map((c) => c?.close() ?? Promise.resolve()),
  );
}

async function makeControlChannel(
  service: TestmanagerdService,
): Promise<number> {
  const channel = await service.makeChannel(TESTMANAGERD_CHANNEL);
  expect(channel).to.not.be.null;
  expect(channel.getCode()).to.be.greaterThan(0);
  return channel.getCode();
}

async function initiateControlSession(
  service: TestmanagerdService,
  channelCode: number,
): Promise<any> {
  const args = new MessageAux();
  args.appendObj(XCODE_VERSION);
  await service.sendMessage(
    channelCode,
    '_IDE_initiateControlSessionWithProtocolVersion:',
    { args },
  );
  const [result] = await service.recvPlist(channelCode);
  expect(result).to.not.be.null;
  return result;
}

function assertNSKeyedArchiverShape(obj: any): void {
  expect(obj).to.have.property('$archiver', 'NSKeyedArchiver');
  expect(obj).to.have.property('$version', 100000);
  expect(obj).to.have.property('$objects').that.is.an('array');
}

/**
 * Run:
 * `UDID=<device-udid> npm run test:testmanagerd`
 *
 * For XCTestConfiguration + ProcessControl tests:
 * `UDID=<device-udid> TEST_RUNNER_BUNDLE_ID=<xctrunner-bundle-id> APP_UNDER_TEST_BUNDLE_ID=<target-app-bundle-id> XCTEST_BUNDLE_ID=<xctest-bundle-id> npm run test:testmanagerd`
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
      );
      await safeClose(
        execConnection?.testmanagerdService,
        execConnection?.remoteXPC,
      );
    });

    it('should connect two independent testmanagerd instances and complete handshakes', async function () {
      controlConnection = await Services.startTestmanagerdService(UDID);
      execConnection = await Services.startTestmanagerdService(UDID);

      expect(controlConnection.testmanagerdService).to.not.be.null;
      expect(execConnection.testmanagerdService).to.not.be.null;
    });

    it('should create channels on both connections', async function () {
      const controlCode = await makeControlChannel(
        controlConnection!.testmanagerdService,
      );
      const execCode = await makeControlChannel(
        execConnection!.testmanagerdService,
      );
    });

    it('should initiate control session with protocol version', async function () {
      const channelCode = await makeControlChannel(
        controlConnection!.testmanagerdService,
      );
      const result = await initiateControlSession(
        controlConnection!.testmanagerdService,
        channelCode,
      );
    });
  });

  describe('XCTestConfiguration write via HouseArrest', function () {
    let houseArrestConnection: HouseArrestServiceWithConnection | null = null;

    before(function () {
      if (
        !TEST_RUNNER_BUNDLE_ID ||
        !APP_UNDER_TEST_BUNDLE_ID ||
        !XCTEST_BUNDLE_ID
      ) {
        this.skip();
      }
    });

    after(async function () {
      await safeClose(houseArrestConnection?.remoteXPC);
    });

    it('should encode XCTestConfiguration, write to device, and read back', async function () {
      houseArrestConnection = await Services.startHouseArrestService(UDID);

      const installProxyConn =
        await Services.startInstallationProxyService(UDID);
      let appPath: string;
      try {
        const lookup = await installProxyConn.installationProxyService.lookup(
          [TEST_RUNNER_BUNDLE_ID!],
          { returnAttributes: ['Path'] },
        );
        appPath = (lookup[TEST_RUNNER_BUNDLE_ID!] as any)?.Path;
        expect(appPath, 'Runner app not found on device').to.be.a('string');
      } finally {
        await safeClose(installProxyConn.remoteXPC);
      }

      const xctestName =
        XCTEST_BUNDLE_ID!.split('.').at(-1) || XCTEST_BUNDLE_ID!;
      const testBundleURL = `file://${appPath}/PlugIns/${xctestName}.xctest`;

      const sessionId = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const encoder = new XCTestConfigurationEncoder();
      const archived = encoder.encodeXCTestConfiguration({
        testBundleURL,
        sessionIdentifier: sessionId,
        targetApplicationBundleID: APP_UNDER_TEST_BUNDLE_ID!,
        initializeForUITesting: true,
        reportResultsToIDE: true,
      });

      assertNSKeyedArchiverShape(archived);

      const plistData = createBinaryPlist(archived);
      expect(plistData).to.be.instanceOf(Buffer);
      expect(plistData.length).to.be.greaterThan(0);

      log.debug(`Serialized XCTestConfiguration: ${plistData.length} bytes`);

      const afcService =
        await houseArrestConnection.houseArrestService.vendContainer(
          TEST_RUNNER_BUNDLE_ID!,
        );

      const configFileName = `Runner-${sessionId.toUpperCase()}.xctestconfiguration`;
      const remotePath = `/tmp/${configFileName}`;

      try {
        try {
          await afcService.mkdir('/tmp');
        } catch {}

        await afcService.setFileContents(remotePath, plistData);
        log.debug(`Wrote XCTestConfiguration to ${remotePath}`);

        const readBack = await afcService.getFileContents(remotePath);
        expect(readBack).to.be.instanceOf(Buffer);
        expect(readBack.length).to.equal(plistData.length);

        assertNSKeyedArchiverShape(parseBinaryPlist(readBack));
      } finally {
        try {
          await afcService.rm(remotePath);
        } catch {}
        afcService.close();
      }
    });
  });

  describe('Testmanagerd + DVT ProcessControl combo', function () {
    let testmanagerdConnection: TestmanagerdServiceWithConnection | null = null;
    let dvtConnection: DVTServiceWithConnection | null = null;

    after(async function () {
      await safeClose(
        testmanagerdConnection?.testmanagerdService,
        testmanagerdConnection?.remoteXPC,
      );
      await safeClose(dvtConnection?.dvtService, dvtConnection?.remoteXPC);
    });

    it('should connect testmanagerd + DVT, launch app via ProcessControl, and authorize PID on control session', async function () {
      testmanagerdConnection = await Services.startTestmanagerdService(UDID);
      dvtConnection = await Services.startDVTService(UDID);

      const channelCode = await makeControlChannel(
        testmanagerdConnection.testmanagerdService,
      );
      const initResult = await initiateControlSession(
        testmanagerdConnection.testmanagerdService,
        channelCode,
      );

      // iOS may return negative PIDs for suspended launch states
      const pid = await dvtConnection.processControl.launch({
        bundleId: 'com.apple.calculator',
        killExisting: true,
      });
      expect(pid).to.be.a('number');
      expect(pid).to.not.equal(0);
      log.debug(`Launched Calculator with PID: ${pid}`);

      const authArgs = new MessageAux();
      authArgs.appendObj(pid);

      await testmanagerdConnection.testmanagerdService.sendMessage(
        channelCode,
        '_IDE_authorizeTestSessionWithProcessID:',
        { args: authArgs },
      );

      const [authResult] =
        await testmanagerdConnection.testmanagerdService.recvPlist(channelCode);
      log.debug('Authorization result:', authResult);

      const absPid = Math.abs(pid);
      try {
        await dvtConnection.processControl.kill(absPid);
        log.debug(`Killed Calculator (PID: ${absPid})`);
      } catch (error) {
        log.debug('Error killing calculator (may have already exited):', error);
      }
    });
  });

  describe('Full XCTest launch flow', function () {
    before(function () {
      if (
        !TEST_RUNNER_BUNDLE_ID ||
        !APP_UNDER_TEST_BUNDLE_ID ||
        !XCTEST_BUNDLE_ID
      ) {
        this.skip();
      }
    });

    it('should execute full XCTest launch lifecycle via runXCTest', async function () {
      this.timeout(Number(process.env.XCTEST_MOCHA_TIMEOUT_MS || 360000));

      const result = await runXCTest({
        udid: UDID,
        testRunnerBundleId: TEST_RUNNER_BUNDLE_ID!,
        appUnderTestBundleId: APP_UNDER_TEST_BUNDLE_ID!,
        xctestBundleId: XCTEST_BUNDLE_ID!,
        timeoutMs: Number(process.env.XCTEST_PLAN_TIMEOUT_MS || 300000),
      });

      log.debug('XCTest run result:', result);

      expect(result.status).to.equal('passed');
      expect(result.sessionIdentifier).to.be.a('string');
      expect(result.testRunnerPid).to.be.greaterThan(0);
      expect(result.durationMs).to.be.greaterThan(0);
    });
  });
});
