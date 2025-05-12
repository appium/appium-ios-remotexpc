import { logger } from '@appium/support';
import { Socket } from 'node:net';
import tls, { type ConnectionOptions, TLSSocket } from 'tls';

import { BasePlistService } from '../../base-plist-service.js';
import { type PairRecord } from '../pair-record/index.js';
import { PlistService } from '../plist/plist-service.js';
import type { PlistMessage, PlistValue } from '../types.js';
import { connectAndRelay, createUsbmux } from '../usbmux/index.js';

const log = logger.getLogger('Lockdown');
const LABEL = 'appium-internal';

interface Device {
  DeviceID: number;
  MessageType: string;
  Properties: {
    ConnectionSpeed: number;
    ConnectionType: string;
    DeviceID: number;
    LocationID: number;
    ProductID: number;
    SerialNumber: string;
    USBSerialNumber: string;
  };
}

interface LockdownServiceInfo {
  lockdownService: LockdownService;
  device: Device;
}

/**
 * Upgrades a socket to TLS
 */
export function upgradeSocketToTLS(
  socket: Socket,
  tlsOptions: Partial<ConnectionOptions> = {},
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.pause();
    log.debug('Upgrading socket to TLS...');
    const secure = tls.connect(
      {
        socket,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ...tlsOptions,
      },
      () => {
        log.info('TLS handshake completed');
        resolve(secure);
      },
    );
    secure.on('error', (err) => {
      log.error(`TLS socket error: ${err}`);
      reject(err);
    });
    socket.on('error', (err) => {
      log.error(`Underlying socket error during TLS: ${err}`);
      reject(err);
    });
  });
}

export class LockdownService extends BasePlistService {
  private readonly _udid: string;
  private _plistAfterTLS?: PlistService;
  private _isTLS = false;
  public _tlsUpgrade?: Promise<void>;

  constructor(socket: Socket, udid: string, autoSecure = true) {
    super(socket);
    this._udid = udid;
    log.info(`LockdownService initialized for UDID: ${udid}`);
    if (autoSecure) {
      this._tlsUpgrade = this.tryUpgradeToTLS().catch((err) =>
        log.warn(`Auto TLS upgrade failed: ${err.message}`),
      );
    }
  }

  async startSession(
    hostID: string,
    systemBUID: string,
    timeout = 5000,
  ): Promise<{ sessionID: string; enableSessionSSL: boolean }> {
    log.debug(`Starting lockdown session with HostID: ${hostID}`);
    const res = await this.sendAndReceive(
      {
        Label: LABEL,
        Request: 'StartSession',
        HostID: hostID,
        SystemBUID: systemBUID,
      },
      timeout,
    );
    if (res.Request === 'StartSession' && res.SessionID) {
      log.info(`Lockdown session started, SessionID: ${res.SessionID}`);
      return {
        sessionID: String(res.SessionID),
        enableSessionSSL: Boolean(res.EnableSessionSSL),
      };
    }
    throw new Error(`Unexpected session data: ${JSON.stringify(res)}`);
  }

  async tryUpgradeToTLS(): Promise<void> {
    const pairRecord = await this.getPairRecord();
    if (
      !pairRecord?.HostCertificate ||
      !pairRecord.HostPrivateKey ||
      !pairRecord.HostID ||
      !pairRecord.SystemBUID
    ) {
      log.warn('Missing certs/session info for TLS upgrade');
      return;
    }
    const sess = await this.startSession(
      pairRecord.HostID,
      pairRecord.SystemBUID,
    );
    if (!sess.enableSessionSSL) {
      log.info('Device did not request TLS upgrade. Continuing unencrypted.');
      return;
    }
    const tlsSocket = await upgradeSocketToTLS(this.getSocket() as Socket, {
      cert: pairRecord.HostCertificate,
      key: pairRecord.HostPrivateKey,
    });
    this._plistAfterTLS = new PlistService(tlsSocket);
    this._isTLS = true;
    log.info('Successfully upgraded connection to TLS');
  }

  public getSocket(): Socket | TLSSocket {
    return this._isTLS && this._plistAfterTLS
      ? this._plistAfterTLS.getSocket()
      : this.getPlistService().getSocket();
  }

  public async sendAndReceive(
    msg: Record<string, PlistValue>,
    timeout = 5000,
  ): Promise<PlistMessage> {
    if (this._isTLS && this._plistAfterTLS) {
      return this._plistAfterTLS.sendPlistAndReceive(msg, timeout);
    }
    return this._plistService.sendPlistAndReceive(msg, timeout);
  }

  public close(): void {
    log.info('Closing LockdownService connections');
    try {
      // Close the TLS service if it exists
      if (this._isTLS && this._plistAfterTLS) {
        this._plistAfterTLS.close();
      } else {
        // Otherwise close the base service
        super.close();
      }
    } catch (err) {
      log.error(`Error on closing socket: ${err}`);
      throw err;
    }
  }

  private async getPairRecord(): Promise<PairRecord | null> {
    log.debug(`Retrieving pair record for UDID: ${this._udid}`);
    const usbmux = await createUsbmux();
    try {
      const record = await usbmux.readPairRecord(this._udid);
      if (!record?.HostCertificate || !record.HostPrivateKey) {
        log.error('Pair record missing certificate or key');
        throw new Error('Pair record missing certificate or key');
      }
      log.info('Pair record retrieved successfully');
      return record;
    } catch (err) {
      log.error(`Error getting pair record for TLS: ${err}`);
      throw err;
    } finally {
      await usbmux
        .close()
        .catch((err) => log.error(`Error closing usbmux: ${err}`));
    }
  }
}

/**
 * Creates a LockdownService using the provided UDID
 */
export async function createLockdownServiceByUDID(
  udid: string,
  port = 62078,
  autoSecure = true,
): Promise<LockdownServiceInfo> {
  let devices;
  const usbmux = await createUsbmux();
  try {
    log.debug('Listing connected devices...');

    devices = await usbmux.listDevices();
    log.debug(
      `Devices: ${devices.map((d) => d.Properties.SerialNumber).join(', ')}`,
    );
  } finally {
    await usbmux
      .close()
      .catch((err) => log.error(`Error closing usbmux: ${err}`));
  }

  if (!devices || devices.length === 0) {
    throw new Error('No devices connected');
  }

  // Verify the provided UDID exists in connected devices
  if (!devices.some((d) => d.Properties.SerialNumber === udid)) {
    throw new Error(`Provided UDID ${udid} not found among connected devices`);
  }

  const selectedUDID = udid;
  log.info(`Using UDID: ${selectedUDID}`);

  const device = devices.find(
    (d) => d.Properties.SerialNumber === selectedUDID,
  );
  if (!device) {
    throw new Error(`UDID ${selectedUDID} not found`);
  }
  log.info(
    `Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`,
  );

  log.debug(`Connecting to device ${device.DeviceID} on port ${port}...`);
  const socket: Socket = await connectAndRelay(device.DeviceID, port);
  log.debug('Socket connected, creating LockdownService');

  const service = new LockdownService(socket, selectedUDID, autoSecure);
  if (autoSecure && service._tlsUpgrade) {
    log.debug('Waiting for TLS upgrade to complete...');
    await service._tlsUpgrade;
  }

  return { lockdownService: service, device };
}
