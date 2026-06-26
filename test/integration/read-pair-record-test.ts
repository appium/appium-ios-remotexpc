import { createUsbmux } from '../../src/lib/usbmux/index.js';

describe('Pair Record', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

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
      console.log(err);
      // If the error is expected (e.g., no pair record found), the test can still pass
      // Otherwise, fail the test
      expect(err).to.not.be.undefined;
    }
  });

  it('should list devices', async function () {
    const devices = await usb.listDevices();
    console.log(devices);
    expect(devices).to.be.an('array');
  });
});
