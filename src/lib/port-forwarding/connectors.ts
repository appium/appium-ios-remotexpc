import { Socket, createConnection } from 'node:net';

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

const connectViaTunnelImpl = async (
  hostOrIdentifier: string,
  port: number,
  connectTimeoutMs = 5000,
): Promise<Socket> =>
  await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: hostOrIdentifier, port });

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onTimeout = (): void => {
      cleanup();
      socket.destroy();
      reject(
        new Error(
          `Connection timed out to ${hostOrIdentifier}:${port} after ${connectTimeoutMs}ms`,
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

/**
 * Connector for tunnel endpoints.
 * The first parameter is treated as tunnel host/address.
 */
export const connectViaTunnel =
  connectViaTunnelImpl satisfies PortForwardingConnector;
