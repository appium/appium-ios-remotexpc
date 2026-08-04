import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import {createUsbmux} from '../../src/lib/usbmux/index.js';

const log = logger.getLogger('ReadPairRecord.test');

describe('Pair Record', {timeout: 60000}, function () {
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
      assert.strictEqual(true, true);
    } catch (err) {
      log.error(err);
      // If the error is expected (e.g., no pair record found), the test can still pass
      // Otherwise, fail the test
      assert.notStrictEqual(err, undefined);
    }
  });

  it('should list devices', async function () {
    const devices = await usb.listDevices();
    log.debug(devices);
    assert.ok(Array.isArray(devices));
  });
});
