import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

import type {DVTInstruments} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('Screenshot.test');
log.level = 'debug';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Screenshot Instrument', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async () => {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
    }
  });

  describe('Screenshot Capture', () => {
    it('should capture a screenshot and return PNG data', async () => {
      const screenshot = await dvtServiceConnection!.screenshot.getScreenshot();

      expect(screenshot).to.be.instanceOf(Buffer);
      expect(screenshot.length).to.be.greaterThan(0);

      // Verify the buffer starts with PNG header
      const hasPngHeader = screenshot.subarray(0, 8).equals(PNG_MAGIC);
      expect(hasPngHeader).to.be.true;
    });
  });
});
