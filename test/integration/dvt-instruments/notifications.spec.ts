import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import sinon from 'sinon';

import type {DVTInstruments} from '../../../src/lib/types.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('notifications.test');
log.level = 'debug';

describe('Notifications', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();

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
        assert.ok(msg !== null && msg !== undefined);
        assert.ok('selector' in msg);
        assert.ok('data' in msg);

        assert.ok(typeof msg.selector === 'string');
        assert.ok(typeof msg.data === 'object' && msg.data !== null && !Array.isArray(msg.data));

        if (msg.selector === 'memoryLevelNotification:') {
          assert.ok('code' in msg.data);
          break;
        } else if (msg.selector === 'applicationStateNotification:') {
          assert.ok('appName' in msg.data);
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
        sandbox.stub(stream, 'write').callsFake(function (chunk: any, ...args: any[]) {
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

        assert.strictEqual(iterationCount, 2);
        assert.ok(logCalls.length > 0);

        const allLogs = logCalls.join('');
        assert.ok(allLogs.includes('Network monitoring has started'));
        assert.ok(allLogs.includes('Network monitoring has ended'));
      } finally {
        sandbox.restore();
      }
    });
  });
});
