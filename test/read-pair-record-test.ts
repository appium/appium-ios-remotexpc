import { createUsbmux } from '../src/lib/Usbmux/index.js';

async function test() {
  try {
    const usb = await createUsbmux();
    await usb.readPairRecord('');
    console.log(await usb.listDevices());
    await usb.close();
  } catch (err) {
    console.log(err);
  }
}

test().catch((err) => {
  console.log(err);
});
