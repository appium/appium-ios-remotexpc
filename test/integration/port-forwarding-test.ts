import { expect } from 'chai';
import { createConnection } from 'node:net';

import {
  DevicePortForwarder,
  connectViaTunnel,
  connectViaUsbmux,
  createUsbmux,
} from '../../src/index.js';

async function canConnectLocalPort(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.setTimeout(0);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      cleanup();
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      cleanup();
      socket.destroy();
      resolve(false);
    });
  });
}

async function resolveUdid(requestedUdid?: string): Promise<string> {
  const usbmux = await createUsbmux();
  try {
    const devices = await usbmux.listDevices();
    if (!devices.length) {
      throw new Error('No devices found via usbmux.');
    }
    if (requestedUdid) {
      const match = devices.find(
        (device) => device.Properties.SerialNumber === requestedUdid,
      );
      if (!match) {
        throw new Error(
          `Requested UDID not found via usbmux: ${requestedUdid}`,
        );
      }
      return requestedUdid;
    }
    return devices[0].Properties.SerialNumber;
  } finally {
    await usbmux.close();
  }
}

describe('Port forwarding (usbmux)', function () {
  this.timeout(30000);

  const localHost = process.env.PORT_FORWARD_HOST ?? '127.0.0.1';
  const localPort = Number.parseInt(
    process.env.PORT_FORWARD_LOCAL_PORT ?? '18100',
    10,
  );
  const devicePort = Number.parseInt(
    process.env.PORT_FORWARD_DEVICE_PORT ?? '',
    10,
  );
  const requestedUdid = process.env.UDID;

  let forwarder: DevicePortForwarder | undefined;

  before(async function () {
    if (!Number.isFinite(devicePort) || devicePort <= 0) {
      this.skip();
    }

    const udid = await resolveUdid(requestedUdid);

    forwarder = new DevicePortForwarder(localPort, devicePort, {
      host: localHost,
      primaryConnector: () => connectViaUsbmux(udid, devicePort),
    });

    await forwarder.start();
  });

  after(async function () {
    if (forwarder) {
      await forwarder.stop();
    }
  });

  it('should expose a reachable local forwarded TCP port', async function () {
    const open = await canConnectLocalPort(localHost, localPort);
    expect(open).to.equal(true);
  });
});

describe('Port forwarding (tunnel)', function () {
  this.timeout(30000);

  const tunnelHost = process.env.PORT_FORWARD_TUNNEL_HOST ?? '';
  const localHost = process.env.PORT_FORWARD_HOST ?? '127.0.0.1';
  const localPort = Number.parseInt(
    process.env.PORT_FORWARD_TUNNEL_LOCAL_PORT ??
      process.env.PORT_FORWARD_LOCAL_PORT ??
      '18101',
    10,
  );
  const devicePort = Number.parseInt(
    process.env.PORT_FORWARD_TUNNEL_DEVICE_PORT ??
      process.env.PORT_FORWARD_DEVICE_PORT ??
      '',
    10,
  );

  let forwarder: DevicePortForwarder | undefined;

  before(async function () {
    if (!tunnelHost || !Number.isFinite(devicePort) || devicePort <= 0) {
      this.skip();
    }

    forwarder = new DevicePortForwarder(localPort, devicePort, {
      host: localHost,
      primaryConnector: () => connectViaTunnel(tunnelHost, devicePort),
    });

    await forwarder.start();
  });

  after(async function () {
    if (forwarder) {
      await forwarder.stop();
    }
  });

  it('should expose a reachable local forwarded TCP port', async function () {
    const open = await canConnectLocalPort(localHost, localPort);
    expect(open).to.equal(true);
  });
});
