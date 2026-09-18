import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import type {Device} from '../../../src/lib/usbmux/index.js';
import * as usbmuxModule from '../../../src/lib/usbmux/index.js';

const UDID = '63c3d055c4f83e960e5980fa68be0fbf7d4ba74c';

// A distinct, recognizable failure that only surfaces once findDeviceByUDID has already matched
// the device and RelayService.start() goes on to dial usbmux.connect() — proving execution got
// past the udid-matching stage without needing a real socket/relay/TLS handshake in this test.
const CONNECT_NOT_IMPLEMENTED = 'connect() not implemented in this test';

function mockDevice(serialNumber: string): Device {
  return {
    DeviceID: 1,
    MessageType: 'Attached',
    Properties: {
      ConnectionSpeed: 480000000,
      ConnectionType: 'USB',
      DeviceID: 1,
      LocationID: 0,
      ProductID: 4776,
      SerialNumber: serialNumber,
      USBSerialNumber: serialNumber,
    },
  };
}

let deviceList: Device[] = [];

// RelayService.start() calls usbmux/index.js's own createUsbmux() as a same-module reference,
// which module mocking does not intercept — so the fake RelayService below (not a fake
// createUsbmux) is what keeps this test from opening a real usbmuxd connection.
class FakeRelayService {
  async start(): Promise<void> {
    throw new Error(CONNECT_NOT_IMPLEMENTED);
  }
}

mock.module('../../../src/lib/usbmux/index.js', {
  namedExports: {
    ...usbmuxModule,
    createUsbmux: async () => ({
      listDevices: async () => deviceList,
      close: async () => {},
    }),
    RelayService: FakeRelayService,
  },
});

const {createLockdownServiceByUDID} = await import('../../../src/lib/lockdown/index.js');

describe('DeviceManager.findDeviceByUDID (via createLockdownServiceByUDID)', function () {
  it('matches a device whose udid differs only by letter case', async function () {
    deviceList = [mockDevice(UDID.toUpperCase())];

    await assert.rejects(
      createLockdownServiceByUDID(UDID, 62078, false),
      (err: unknown) => err instanceof Error && err.message === CONNECT_NOT_IMPLEMENTED,
    );
  });

  it('throws DeviceNotFoundError when no device matches, even case-insensitively', async function () {
    deviceList = [mockDevice('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')];

    await assert.rejects(createLockdownServiceByUDID(UDID, 62078, false), /Device with UDID .* not found/);
  });
});
