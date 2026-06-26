import { createConnection } from 'node:net';

import {
  DevicePortForwarder,
  connectViaTunnel,
  connectViaUsbmux,
  createUsbmux,
} from '../../src/index.js';

/**
 * Integration tests for {@link DevicePortForwarder} with usbmux and tunnel registry
 * upstream via {@link connectViaTunnel} (no TLS or Apple framing — only TCP
 * connect must succeed for the tunnel case).
 *
 * Environment variables:
 *
 * **Shared**
 * - `PORT_FORWARD_HOST` — bind address for the local forwarder (default `127.0.0.1`).
 *
 * **usbmux suite** (`describe('Port forwarding (usbmux)')`)
 * - `PORT_FORWARD_DEVICE_PORT` — **required** (unless skipped): destination TCP port on the
 *   device (e.g. `62078` for lockdownd). A listener must accept or the test fails.
 * - `PORT_FORWARD_LOCAL_PORT` — local listen port (default `18100`).
 * - `UDID` — optional; defaults to the first device from usbmux.
 *
 * **Tunnel suite** (`describe('Port forwarding (tunnel)')`)
 *
 * Requires the tunnel registry (`scripts/tunnel-creation.mjs`) for the device UDID.
 * Upstream is `connectViaTunnel(udid, port)` — host is resolved from the registry
 * on each upstream connect.
 *
 * - `UDID` — optional; defaults to the first device from usbmux.
 * - `PORT_FORWARD_TUNNEL_DEVICE_PORT` or `PORT_FORWARD_DEVICE_PORT` — **required** (unless
 *   skipped): TCP port reachable on the tunnel interface (e.g. registry `rsdPort` or a
 *   device service port like `62078`).
 * - `PORT_FORWARD_TUNNEL_LOCAL_PORT` or `PORT_FORWARD_LOCAL_PORT` — local listen port
 *   (defaults: tunnel suite uses `18101` when both are unset; otherwise
 *   `PORT_FORWARD_LOCAL_PORT` applies when `PORT_FORWARD_TUNNEL_LOCAL_PORT` is unset).
 */

/**
 * Connects to the local forwarder and requires the upstream socket to be
 * established (or fails on upstream error / timeout). A plain local TCP
 * accept alone is not enough.
 */
async function assertUpstreamConnects(
  forwarder: DevicePortForwarder,
  localHost: string,
  localPort: number,
  timeoutMs = 10000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupListeners();
      clientSocket.destroy();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for upstream (check tunnel listener / device port)`,
        ),
      );
    }, timeoutMs);

    const cleanupListeners = (): void => {
      clearTimeout(timer);
      forwarder.off('upstreamConnected', onUpstreamOk);
      forwarder.off('upstreamConnectError', onUpstreamErr);
    };

    const onUpstreamOk = (): void => {
      cleanupListeners();
      clientSocket.destroy();
      resolve();
    };

    const onUpstreamErr = (err: unknown): void => {
      cleanupListeners();
      clientSocket.destroy();
      reject(
        err instanceof Error
          ? err
          : new Error(`Upstream connect failed: ${String(err)}`),
      );
    };

    forwarder.once('upstreamConnected', onUpstreamOk);
    forwarder.once('upstreamConnectError', onUpstreamErr);

    const clientSocket = createConnection({ host: localHost, port: localPort });
    clientSocket.once('error', (err: Error) => {
      cleanupListeners();
      clientSocket.destroy();
      reject(err);
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

  it('should complete upstream after connecting to the local forwarder', async function () {
    expect(forwarder).to.exist;
    await assertUpstreamConnects(forwarder!, localHost, localPort);
  });
});

describe('Port forwarding (tunnel)', function () {
  this.timeout(30000);

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
  const requestedUdid = process.env.UDID;

  let forwarder: DevicePortForwarder | undefined;

  before(async function () {
    if (!Number.isFinite(devicePort) || devicePort <= 0) {
      this.skip();
    }

    const udid = await resolveUdid(requestedUdid);

    forwarder = new DevicePortForwarder(localPort, devicePort, {
      host: localHost,
      primaryConnector: () => connectViaTunnel(udid, devicePort),
    });

    await forwarder.start();
  });

  after(async function () {
    if (forwarder) {
      await forwarder.stop();
    }
  });

  it('should complete upstream after connecting to the local forwarder', async function () {
    expect(forwarder).to.exist;
    await assertUpstreamConnects(forwarder!, localHost, localPort);
  });
});
