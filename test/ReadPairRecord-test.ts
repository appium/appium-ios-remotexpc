import { createUsbmux } from '../src/lib/usbmux/index.js';

async function test() {

    try {
        const usb = await createUsbmux();
        await usb.readPairRecord('00008110-001854423C3A801E');
        console.log(await usb.listDevices());
        await usb.close();

    } catch (err) {
        console.log(err);
    }
}


test().catch((err)=> {
    console.log(err);
});