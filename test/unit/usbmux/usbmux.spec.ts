import assert from 'node:assert/strict';
import {type AddressInfo, type Server, type Socket, createConnection, createServer} from 'node:net';
import {resolve} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {fs, node} from '@appium/support';

import {type Device, Usbmux} from '../../../src/lib/usbmux/index.js';
import {UsbmuxDecoder} from '../../../src/lib/usbmux/usbmux-decoder.js';
import {prioritizeUsbOverNetworkForDuplicateUdids} from '../../../src/lib/usbmux/utils.js';
import {UDID, fixtures, getServerWithFixtures} from '../fixtures/index.js';

const PKG_ROOT = node.getModuleRootSync('appium-ios-remotexpc', fileURLToPath(import.meta.url));

const DUP_UDID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function mockUsbmuxDevice(
  deviceId: number,
  serialNumber: string,
  connectionType: 'USB' | 'Network',
  opts?: {connectionSpeed?: number; productId?: number},
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
    ({server, socket} = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);
    const devices = await usbmux.listDevices();
    assert.strictEqual(devices.length, 1);
  });

  it('should not throw when the socket errors without an error listener', async function () {
    ({server, socket} = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);

    // Emitting on the service mirrors BaseSocketService re-emitting a socket
    // error; without a listener Node would throw.
    usbmux.emit('error', new Error('simulated usbmuxd failure'));
  });

  it('should fail due to timeout', async function () {
    ({server, socket} = await getServerWithFixtures());
    usbmux = new Usbmux(socket);

    await usbmux.listDevices(-1).catch((err) => {
      assert.ok(err instanceof Error);
    });
  });

  it('should find correct device', async function () {
    ({server, socket} = await getServerWithFixtures(fixtures.DEVICE_LIST));
    usbmux = new Usbmux(socket);

    const device = await usbmux.findDevice(UDID);
    assert.notStrictEqual(device, undefined);
    if (device) {
      assert.strictEqual(device.Properties.SerialNumber, UDID);
    }
  });

  it('should preserve remainder bytes in decoder buffer when partial chunk arrives', function () {
    const decoder = new UsbmuxDecoder();
    const chunk = Buffer.from([0x05, 0x00, 0x00, 0x00]);
    decoder.write(chunk);
    assert.deepStrictEqual(decoder.buffer, chunk);
  });

  it('should emit error on malformed payload instead of throwing synchronously in decoder', async function () {
    const decoder = new UsbmuxDecoder();
    const errorPromise = new Promise<Error>((resolve) => {
      decoder.once('error', resolve);
    });

    const header = Buffer.alloc(16);
    header.writeUInt32LE(20, 0); // length: 20 bytes total (16 header + 4 payload)
    header.writeUInt32LE(1, 4); // version
    header.writeUInt32LE(8, 8); // type
    header.writeUInt32LE(1, 12); // tag
    const invalidPayload = Buffer.from('bad!');

    decoder.write(Buffer.concat([header, invalidPayload]));
    const err = await errorPromise;
    assert.ok(err instanceof Error);
  });

  it('should unshift unconsumed trailing bytes received alongside connect result', async function () {
    const connectFixture = Buffer.from(
      await fs.readFile(resolve(PKG_ROOT, 'test', 'unit', 'fixtures', 'usbmuxconnectmessage.bin')),
    );
    const trailingGreeting = Buffer.from('REMOTE_SERVICE_GREETING');

    server = createServer((s: Socket) => {
      s.once('data', (data: Buffer) => {
        const clientTag = data.readUInt32LE(12);
        connectFixture.writeUInt32LE(clientTag, 12);
        s.write(Buffer.concat([connectFixture, trailingGreeting]));
      });
    });
    server.listen();
    const addr = server.address() as AddressInfo;
    socket = createConnection(addr.port);

    usbmux = new Usbmux(socket);
    const connectedSocket = await usbmux.connect(1, 62078);

    const received = await new Promise<Buffer>((resolve) => {
      connectedSocket.once('data', resolve);
      connectedSocket.resume();
    });

    assert.deepStrictEqual(received, trailingGreeting);
    connectedSocket.destroy();
  });

  it('should order duplicate UDIDs with USB before Network', function () {
    const net = mockUsbmuxDevice(2, DUP_UDID, 'Network');
    const usb = mockUsbmuxDevice(1, DUP_UDID, 'USB');
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, usb]);
    assert.deepStrictEqual(
      sorted.map((d) => d.DeviceID),
      [1, 2],
    );
  });

  it('should not pull duplicate UDIDs into a block when another device is between', function () {
    const net = mockUsbmuxDevice(2, DUP_UDID, 'Network');
    const usb = mockUsbmuxDevice(1, DUP_UDID, 'USB');
    const other = mockUsbmuxDevice(99, 'other-udid', 'USB', {
      connectionSpeed: 0,
      productId: 0,
    });
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([net, other, usb]);
    assert.deepStrictEqual(
      sorted.map((d) => d.DeviceID),
      [1, 99, 2],
    );
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
    const sorted = prioritizeUsbOverNetworkForDuplicateUdids([aNet, bUsb, aUsb, cNet]);
    assert.deepStrictEqual(
      sorted.map((d) => d.DeviceID),
      [1, 10, 2, 20],
    );
    assert.deepStrictEqual(
      sorted.map((d) => d.Properties.SerialNumber),
      ['dup-a', 'only-b', 'dup-a', 'only-c'],
    );
  });
});
