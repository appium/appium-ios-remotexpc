import { logger } from '@appium/support';
import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';
import sinon from 'sinon';

import type { DVTInstruments } from '../../../src/lib/types.js';
import * as Services from '../../../src/services.js';
import { requireDeviceUdid } from '../helpers/device.js';

const log = logger.getLogger('notifications.test');
log.level = 'debug';

describe('Notifications', { timeout: 30000 }, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  const udid = requireDeviceUdid();

  before(async function () {
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async function () {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Notifications', () => {
    it('should receive notifications logs through async iterator', async () => {
      const notifications = dvtServiceConnection!.notification;

      for await (const msg of notifications.messages()) {
        expect(msg).to.exist;
        expect(msg).to.have.property('selector');
        expect(msg).to.have.property('data');

        expect(msg.selector).to.be.a('string');
        expect(msg.data).to.be.an('object');

        if (msg.selector === 'memoryLevelNotification:') {
          expect(msg.data).to.have.property('code');
          break;
        } else if (msg.selector === 'applicationStateNotification:') {
          expect(msg.data).to.have.property('appName');
          break;
        }
      }
    });

    it('should stop messages generator after breaking from a loop', async () => {
      const notifications = dvtServiceConnection!.notification;
      const sandbox = sinon.createSandbox();
      const logCalls: string[] = [];

      // Stub a stream and capture output
      const stubStream = (stream: NodeJS.WriteStream) => {
        const original = stream.write.bind(stream);
        sandbox.stub(stream, 'write').callsFake(function (
          chunk: any,
          ...args: any[]
        ) {
          logCalls.push(chunk.toString());
          return original(chunk, ...args);
        } as any);
      };

      stubStream(process.stderr);

      let iterationCount = 0;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _msg of notifications.messages()) {
          if (++iterationCount === 2) {
            break;
          }
        }

        expect(iterationCount).to.equal(2);
        expect(logCalls.length).to.be.greaterThan(0);

        const allLogs = logCalls.join('');
        expect(allLogs).to.include('Network monitoring has started');
        expect(allLogs).to.include('Network monitoring has ended');
      } finally {
        sandbox.restore();
      }
    });
  });
});
