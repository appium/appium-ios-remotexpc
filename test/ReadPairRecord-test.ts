import { createUsbmux } from '../src/lib/usbmux/index.js';

async function test() {
  try {
    const usb = await createUsbmux();
    await usb.readPairRecord('00008130000474C114E1001C');
    console.log(await usb.listDevices());
    await usb.close();
  } catch (err) {
    console.log(err);
  }
}

test().catch((err) => {
  console.log(err);
});
