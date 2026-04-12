import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Server, Socket } from 'node:net';

import { type Device, Usbmux } from '../../../src/lib/usbmux/index.js';
import { prioritizeUsbOverNetworkForDuplicateUdids } from '../../../src/lib/usbmux/utils.js';
import { UDID, fixtures, getServerWithFixtures } from '../fixtures/index.js';

use(chaiAsPromised);

describe('usbmux', function () {
  let usbmux: Usbmux | null;
  let server: Server | null;
  let socket: Socket | null;

  beforeEach(function () {
    usbmux = null;
    server = null;
    socket = null;
  });

  afterEach(async function () {
    if (usbmux) {
      usbmux.close();
      usbmux = null;
    }

    // Add a small delay to avoid connection reset errors
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (server) {
      server.close();
      server = null;
    }

    socket = null;
  });

  it('should read usbmux message', async function () {
    ({ server, socket } = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);
    const devices = await usbmux.listDevices();
    expect(devices.length).to.equal(1);
  });

  it('should fail due to timeout', async function () {
    ({ server, socket } = await getServerWithFixtures());
    usbmux = new Usbmux(socket);

    await expect(usbmux.listDevices(-1)).to.be.rejected;
  });

  it('should find correct device', async function () {
    ({ server, socket } = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);

    const device = await usbmux.findDevice(UDID);
    expect(device).to.not.be.undefined;
    if (device) {
      expect(device.Properties.SerialNumber).to.equal(UDID);
    }
  });

  it('should order duplicate UDIDs with USB before Network', function () {
    const udid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const net: Device = {
      DeviceID: 2,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: 'Network',
        DeviceID: 2,
        LocationID: 0,
        ProductID: 4776,
        SerialNumber: udid,
        USBSerialNumber: udid,
      },
    };
    const usb: Device = {
      DeviceID: 1,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: 'USB',
        DeviceID: 1,
        LocationID: 0,
        ProductID: 4776,
        SerialNumber: udid,
        USBSerialNumber: udid,
      },
    };
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, usb]);
    expect(sorted.map((d) => d.DeviceID)).to.deep.equal([1, 2]);
  });

  it('should not pull duplicate UDIDs into a block when another device is between', function () {
    const udid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const net: Device = {
      DeviceID: 2,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: 'Network',
        DeviceID: 2,
        LocationID: 0,
        ProductID: 4776,
        SerialNumber: udid,
        USBSerialNumber: udid,
      },
    };
    const usb: Device = {
      DeviceID: 1,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: 'USB',
        DeviceID: 1,
        LocationID: 0,
        ProductID: 4776,
        SerialNumber: udid,
        USBSerialNumber: udid,
      },
    };
    const other: Device = {
      DeviceID: 99,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 0,
        ConnectionType: 'USB',
        DeviceID: 99,
        LocationID: 0,
        ProductID: 0,
        SerialNumber: 'other-udid',
        USBSerialNumber: 'other-udid',
      },
    };
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, other, usb]);
    expect(sorted.map((d) => d.DeviceID)).to.deep.equal([1, 99, 2]);
  });

  it('should preserve order for unique UDIDs', function () {
    const a: Device = {
      DeviceID: 1,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 0,
        ConnectionType: 'USB',
        DeviceID: 1,
        LocationID: 0,
        ProductID: 0,
        SerialNumber: 'udid-a',
        USBSerialNumber: 'udid-a',
      },
    };
    const b: Device = {
      DeviceID: 2,
      MessageType: 'Attached',
      Properties: {
        ConnectionSpeed: 0,
        ConnectionType: 'Network',
        DeviceID: 2,
        LocationID: 0,
        ProductID: 0,
        SerialNumber: 'udid-b',
        USBSerialNumber: 'udid-b',
      },
    };
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([a, b]);
    expect(sorted.map((d) => d.Properties.SerialNumber)).to.deep.equal([
      'udid-a',
      'udid-b',
    ]);
  });
});
