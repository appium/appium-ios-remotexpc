import { logger } from '@appium/support';
import { TLSSocket } from 'tls';

import {
  LockdownService,
  upgradeSocketToTLS,
} from '../../../lib/lockdown/index.js';
import { PlistService } from '../../../lib/plist/plist-service.js';
import { createUsbmux } from '../../../lib/usbmux/index.js';

const log = logger.getLogger('TunnelService');
const LABEL = 'appium-internal';

/**
 * Starts a CoreDeviceProxy session over an existing TLS-upgraded lockdown connection.
 *
 * @param lockdownClient - The TLS-upgraded lockdown client used to send the StartService request.
 * @param deviceID - The device identifier to be used in the Connect request.
 * @param udid - The device UDID used to retrieve the pair record.
 * @param tlsOptions - TLS options for upgrading the usbmuxd socket.
 * @returns A promise that resolves with a TLS-upgraded socket and PlistService for communication with CoreDeviceProxy.
 */
export async function startCoreDeviceProxy(
  lockdownClient: LockdownService,
  deviceID: number | string,
  udid: string,
  tlsOptions: Partial<import('tls').ConnectionOptions> = {},
): Promise<{ socket: TLSSocket; plistService: PlistService }> {
  // Wait for TLS upgrade to complete if in progress
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

    log.debug('Socket connected to CoreDeviceProxy, upgrading to TLS...');

    const fullTlsOptions = {
      ...tlsOptions,
      cert: pairRecord.HostCertificate,
      key: pairRecord.HostPrivateKey,
    };

    const tlsSocket = await upgradeSocketToTLS(
      coreDeviceSocket,
      fullTlsOptions,
    );

    const plistService = new PlistService(tlsSocket);

    return { socket: tlsSocket, plistService };
  } catch (err) {
    // If we haven't connected yet, we can safely close the usbmux
    await usbmux
      .close()
      .catch((closeErr) => log.error(`Error closing usbmux: ${closeErr}`));
    throw err;
  }
}
