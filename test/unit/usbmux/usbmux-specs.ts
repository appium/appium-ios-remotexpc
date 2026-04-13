import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Server, Socket } from 'node:net';

import { type Device, Usbmux } from '../../../src/lib/usbmux/index.js';
import { prioritizeUsbOverNetworkForDuplicateUdids } from '../../../src/lib/usbmux/utils.js';
import { UDID, fixtures, getServerWithFixtures } from '../fixtures/index.js';

use(chaiAsPromised);

const DUP_UDID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function mockUsbmuxDevice(
  deviceId: number,
  serialNumber: string,
  connectionType: 'USB' | 'Network',
  opts?: { connectionSpeed?: number; productId?: number },
): Device {
  const connectionSpeed = opts?.connectionSpeed ?? 480000000;
  const productId = opts?.productId ?? 4776;
  return {
    DeviceID: deviceId,
    MessageType: 'Attached',
    Properties: {
      ConnectionSpeed: connectionSpeed,
      ConnectionType: connectionType,
      DeviceID: deviceId,
      LocationID: 0,
      ProductID: productId,
      SerialNumber: serialNumber,
      USBSerialNumber: serialNumber,
    },
  };
}

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
    const net = mockUsbmuxDevice(2, DUP_UDID, 'Network');
    const usb = mockUsbmuxDevice(1, DUP_UDID, 'USB');
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, usb]);
    expect(sorted.map((d) => d.DeviceID)).to.deep.equal([1, 2]);
  });

  it('should not pull duplicate UDIDs into a block when another device is between', function () {
    const net = mockUsbmuxDevice(2, DUP_UDID, 'Network');
    const usb = mockUsbmuxDevice(1, DUP_UDID, 'USB');
    const other = mockUsbmuxDevice(99, 'other-udid', 'USB', {
      connectionSpeed: 0,
      productId: 0,
    });
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, other, usb]);
    expect(sorted.map((d) => d.DeviceID)).to.deep.equal([1, 99, 2]);
  });

  it('should reorder mixed duplicate and unique UDIDs without breaking interleaving', function () {
    const aNet = mockUsbmuxDevice(2, 'dup-a', 'Network');
    const bUsb = mockUsbmuxDevice(10, 'only-b', 'USB', {
      connectionSpeed: 0,
      productId: 0,
    });
    const aUsb = mockUsbmuxDevice(1, 'dup-a', 'USB');
    const cNet = mockUsbmuxDevice(20, 'only-c', 'Network', {
      connectionSpeed: 0,
      productId: 0,
    });
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([
      aNet,
      bUsb,
      aUsb,
      cNet,
    ]);
    expect(sorted.map((d) => d.DeviceID)).to.deep.equal([1, 10, 2, 20]);
    expect(sorted.map((d) => d.Properties.SerialNumber)).to.deep.equal([
      'dup-a',
      'only-b',
      'dup-a',
      'only-c',
    ]);
  });
});
