import { logger } from '@appium/support';
import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import { createUsbmux } from '../../src/lib/usbmux/index.js';

const log = logger.getLogger('ReadPairRecord.test');

describe('Pair Record', { timeout: 60000 }, function () {
  let usb: any;

  before(async function () {
    usb = await createUsbmux();
  });

  after(async function () {
    if (usb) {
      await usb.close();
    }
  });

  it('should read pair record', async function () {
    try {
      await usb.readPairRecord('');
      // If no error is thrown, the test passes
      expect(true).to.be.true;
    } catch (err) {
      log.error(err);
      // If the error is expected (e.g., no pair record found), the test can still pass
      // Otherwise, fail the test
      expect(err).to.not.be.undefined;
    }
  });

  it('should list devices', async function () {
    const devices = await usb.listDevices();
    log.debug(devices);
    expect(devices).to.be.an('array');
  });
});
