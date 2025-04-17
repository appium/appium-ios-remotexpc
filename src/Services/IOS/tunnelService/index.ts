import { TLSSocket } from 'tls';

import {
  LockdownService,
  upgradeSocketToTLS,
} from '../../../lib/Lockdown/index.js';
import { PlistService } from '../../../lib/Plist/PlistService.js';

const { createUsbmux } = await import('../../../lib/usbmux/index.js');

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
  if (lockdownClient._tlsUpgrade) {
    await lockdownClient._tlsUpgrade;
  }

  const response = await lockdownClient.sendAndReceive({
    Label: LABEL,
    Request: 'StartService',
    Service: 'com.apple.internal.devicecompute.CoreDeviceProxy',
    EscrowBag: null,
  });

  lockdownClient.close();

  if (!response.Port) {
    throw new Error("Service didn't return a port");
  }

  console.log(
    `Connecting to CoreDeviceProxy service on port: ${response.Port}`,
  );

  const usbmux = await createUsbmux();

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

  console.log('Socket connected to CoreDeviceProxy, upgrading to TLS...');

  const fullTlsOptions = {
    ...tlsOptions,
    cert: pairRecord.HostCertificate,
    key: pairRecord.HostPrivateKey,
  };

  const tlsSocket = await upgradeSocketToTLS(coreDeviceSocket, fullTlsOptions);

  const plistService = new PlistService(tlsSocket);

  return { socket: tlsSocket, plistService };
}
