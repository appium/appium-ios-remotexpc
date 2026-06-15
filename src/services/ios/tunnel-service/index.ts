import type { Socket } from 'node:net';

import type { LockdownService } from '../../../lib/lockdown/index.js';
import { getLogger } from '../../../lib/logger.js';
import { createUsbmux } from '../../../lib/usbmux/index.js';

const log = getLogger('TunnelService');
const LABEL = 'appium-internal';

export interface CoreDeviceProxyTcpSession {
  socket: Socket;
  cert: string;
  key: string;
}

/**
 * Starts CoreDeviceProxy over plain TCP (no Node TLS). Use with
 * {@link connectToTunnelLockdown} in appium-ios-tuntap.
 */
export async function startCoreDeviceProxyTcp(
  lockdownClient: LockdownService,
  deviceID: number | string,
  udid: string,
): Promise<CoreDeviceProxyTcpSession> {
  await lockdownClient.waitForTLSUpgrade();

  const response = await lockdownClient.sendAndReceive({
    Label: LABEL,
    Request: 'StartService',
    Service: 'com.apple.internal.devicecompute.CoreDeviceProxy',
    EscrowBag: null,
  });

  lockdownClient.close();

  if (!response.Port) {
    throw new Error('Service didnt return a port');
  }

  log.debug(`Connecting to CoreDeviceProxy service on port: ${response.Port}`);

  const usbmux = await createUsbmux();
  try {
    const pairRecord = await usbmux.readPairRecord(udid);
    if (
      !pairRecord ||
      !pairRecord.HostCertificate ||
      !pairRecord.HostPrivateKey
    ) {
      throw new Error(
        'Missing required pair record or certificates for TLS upgrade',
      );
    }

    const coreDeviceSocket = await usbmux.connect(
      Number(deviceID),
      Number(response.Port),
    );

    log.debug(
      'Socket connected to CoreDeviceProxy (raw TCP, native TLS in tuntap)',
    );

    return {
      socket: coreDeviceSocket,
      cert: pairRecord.HostCertificate,
      key: pairRecord.HostPrivateKey,
    };
  } catch (err) {
    await usbmux
      .close()
      .catch((closeErr) => log.error(`Error closing usbmux: ${closeErr}`));
    throw err;
  }
}
