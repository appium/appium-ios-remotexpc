import { type Socket, createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

import { getTunnelForDevice } from '../tunnel/tunnel-availability.js';
import { createUsbmux } from '../usbmux/index.js';
import type { PortForwardingConnector } from './types.js';

const connectViaUsbmuxImpl = async (
  udid: string,
  devicePort: number,
  connectTimeoutMs = 5000,
): Promise<Socket> => {
  const usbmux = await createUsbmux();
  let remoteSocket: Socket | undefined;
  try {
    const device = await usbmux.findDevice(udid, connectTimeoutMs);
    if (!device) {
      throw new Error(`Device with UDID ${udid} not found`);
    }
    remoteSocket = await usbmux.connect(
      device.DeviceID,
      devicePort,
      connectTimeoutMs,
    );
    return remoteSocket;
  } catch (err) {
    if (!remoteSocket) {
      await usbmux.close().catch(() => {});
    }
    throw err;
  }
};

/**
 * Default upstream connector backed by usbmux.
 */
export const connectViaUsbmux =
  connectViaUsbmuxImpl satisfies PortForwardingConnector;

const connectToTunnelHost = async (
  host: string,
  port: number,
  connectTimeoutMs = 5000,
): Promise<Socket> =>
  await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port });

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onTimeout = (): void => {
      cleanup();
      socket.destroy();
      reject(
        new Error(
          `Connection timed out to ${host}:${port} after ${connectTimeoutMs}ms`,
        ),
      );
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      socket.off('connect', onConnect);
      socket.setTimeout(0);
    };

    socket.setTimeout(connectTimeoutMs);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('connect', onConnect);
  });

const connectViaTunnelImpl = async (
  udid: string,
  devicePort: number,
  connectTimeoutMs = 5000,
): Promise<Socket> => {
  const deadline = performance.now() + connectTimeoutMs;
  const remainingMs = (): number =>
    Math.max(0, Math.ceil(deadline - performance.now()));

  const endpoint = await getTunnelForDevice(udid, { waitMs: remainingMs() });
  const tcpTimeoutMs = Math.max(remainingMs(), 1000);
  return connectToTunnelHost(endpoint.host, devicePort, tcpTimeoutMs);
};

/**
 * Resolve the current tunnel host from the registry, then connect to `devicePort`.
 */
export const connectViaTunnel =
  connectViaTunnelImpl satisfies PortForwardingConnector;
