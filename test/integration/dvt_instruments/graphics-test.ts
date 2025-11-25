import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../../src/lib/types.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('Graphics.test');
log.level = 'debug';

describe('Graphics', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '00008030-000318693E32402E';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  describe('Graphics Sampling', () => {
    it('should receive graphics logs through async iterator', async () => {
      const graphics = dvtServiceConnection!.graphics;
      const messages: unknown[] = [];
      const maxMessages = 5;

      for await (const msg of graphics) {
        // Skip null messages which are sent initially
        if (msg === null) {
          log.debug('Skipping null message');
          continue;
        }

        log.info('Graphics message:', msg);
        messages.push(msg);

        if (messages.length >= maxMessages) {
          break;
        }
      }

      expect(messages).to.have.lengthOf(maxMessages);

      // Verify we received valid messages
      for (const msg of messages) {
        expect(msg).to.exist;
        expect(msg).to.be.an('object');
      }
    });

    it('should handle break in iteration properly', async () => {
      const graphics = dvtServiceConnection!.graphics;

      let iterationCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _msg of graphics) {
        iterationCount++;

        if (iterationCount === 2) {
          break;
        }
      }

      expect(iterationCount).to.equal(2);
    });
  });
});
