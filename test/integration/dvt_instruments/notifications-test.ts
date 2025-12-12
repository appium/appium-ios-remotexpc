import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../../src/lib/types.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('notifications.test');
log.level = 'debug';

describe('Notifications', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async function () {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {
        // Ignore cleanup errors
      }

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Notifications', () => {
    it('should receive notifications logs through async iterator', async () => {
      const notifications = dvtServiceConnection!.notification;

      for await (const msg of notifications.messages()) {
        if (msg.selector === null) {
          log.debug('Skipping null message');
          continue;
        }
        expect(msg).to.exist;
        expect(msg).to.have.property('selector');
        expect(msg).to.have.property('data');

        expect(msg.selector).to.be.a('string');
        expect(msg.data).to.be.an('array');

        if (msg.selector === 'memoryLevelNotification:') {
          expect(msg.data[0]).to.have.property('code');
          break;
        } else if (msg.selector === 'applicationStateNotification:') {
          expect(msg.data[0]).to.have.property('appName');
          break;
        }
      }
    });

    it('should handle break in iteration properly', async () => {
      const notifications = dvtServiceConnection!.notification;

      let iterationCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _msg of notifications.messages()) {
        iterationCount++;

        if (iterationCount === 2) {
          break;
        }
      }

      expect(iterationCount).to.equal(2);
    });
  });
});
