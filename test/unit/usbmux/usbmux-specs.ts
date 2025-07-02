import type { expect as expectType } from 'chai';
import { Server, Socket } from 'node:net';

import { Usbmux } from '../../../src/lib/usbmux/index.js';
import { UDID, fixtures, getServerWithFixtures } from '../fixtures/index.js';

let chai;
let chaiAsPromised;
let expect: typeof expectType;

before(async function () {
  chai = await import('chai');
  chaiAsPromised = await import('chai-as-promised');
  chai.use(chaiAsPromised.default);
  chai.should();
  expect = chai.expect;
});

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
});
