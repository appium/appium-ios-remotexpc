import { Socket } from 'node:net';
import tls, { type ConnectionOptions, TLSSocket } from 'tls';

import { BasePlistService } from '../../BasePlistService.js';
import { type PairRecord } from '../PairRecord/index.js';
import { PlistService } from '../Plist/PlistService.js';

const { createUsbmux, connectAndRelay } = await import('../usbmux/index.js');
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
 * Simple interactive UDID selector using arrow keys, defaults if only one device
 */
const promptUserToSelectUDID = async (devices: Device[]): Promise<string> => {
  if (devices.length === 1) {
    const single = devices[0].Properties.SerialNumber;
    console.log(`Only one device found, selecting UDID: ${single}`);
    return single;
  }

  return await new Promise<string>((resolve) => {
    let selected = 0;
    const render = () => {
      console.clear();
      console.log('Select a device UDID:');
      devices.forEach((d, i) => {
        const prefix = i === selected ? '>' : ' ';
        console.log(
          `${prefix} ${d.Properties.SerialNumber} - ${d.Properties.ConnectionType}`,
        );
      });
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKey = (key: string) => {
      if (key === '\u0003') {
        console.log('User canceled selection (Ctrl+C)');
        process.exit();
      } else if (key === '\u001B[A') {
        selected = (selected - 1 + devices.length) % devices.length;
        render();
      } else if (key === '\u001B[B') {
        selected = (selected + 1) % devices.length;
        render();
      } else if (key === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onKey);
        const udid = devices[selected].Properties.SerialNumber;
        console.clear();
        console.log(`Selected UDID: ${udid}`);
        resolve(udid);
      }
    };

    render();
    process.stdin.on('data', onKey);
  });
};

/**
 * Upgrades a socket to TLS
 */
export function upgradeSocketToTLS(
  socket: Socket,
  tlsOptions: Partial<ConnectionOptions> = {},
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.pause();
    console.log('Upgrading socket to TLS...');
    const secure = tls.connect(
      {
        socket,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ...tlsOptions,
      },
      () => {
        console.log('TLS handshake completed');
        resolve(secure);
      },
    );
    secure.on('error', (err) => {
      console.error('TLS socket error:', err);
      reject(err);
    });
    socket.on('error', (err) => {
      console.error('Underlying socket error during TLS:', err);
      reject(err);
    });
  });
}

export class LockdownService extends BasePlistService {
  private socket: Socket | TLSSocket;
  private udid: string;
  private _plistAfterTLS?: PlistService;
  private _isTLS = false;
  public _tlsUpgrade?: Promise<void>;

  constructor(socket: Socket, udid: string, autoSecure = true) {
    super(socket);
    this.socket = socket;
    this.udid = udid;
    console.log(`LockdownService initialized for UDID: ${udid}`);
    if (autoSecure) {
      this._tlsUpgrade = this.tryUpgradeToTLS().catch((err) =>
        console.warn('Auto TLS upgrade failed:', err.message),
      );
    }
  }

  async startSession(hostID: string, systemBUID: string, timeout = 5000) {
    console.log('Starting lockdown session with HostID:', hostID);
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
      console.log('Lockdown session started, SessionID:', res.SessionID);
      return {
        sessionID: res.SessionID,
        enableSessionSSL: res.EnableSessionSSL,
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
      console.warn('Missing certs/session info for TLS upgrade');
      return;
    }
    let sess;
    try {
      sess = await this.startSession(pairRecord.HostID, pairRecord.SystemBUID);
    } catch (err) {
      console.error('Failed to start session:', err);
      throw err;
    }
    if (!sess.enableSessionSSL) {
      console.log(
        'Device did not request TLS upgrade. Continuing unencrypted.',
      );
      return;
    }
    try {
      const tlsSocket = await upgradeSocketToTLS(this.socket as Socket, {
        cert: pairRecord.HostCertificate,
        key: pairRecord.HostPrivateKey,
      });
      this.socket = tlsSocket;
      this._plistAfterTLS = new PlistService(tlsSocket);
      this._isTLS = true;
      console.log('Successfully upgraded connection to TLS');
    } catch (err) {
      console.error('Failed to upgrade to TLS:', err);
      throw err;
    }
  }

  public getSocket() {
    return this.socket;
  }

  public async sendAndReceive(msg: Record<string, unknown>, timeout = 5000) {
    if (this._isTLS && this._plistAfterTLS) {
      return this._plistAfterTLS.sendPlistAndReceive(msg, timeout);
    }
    return this._plistService.sendPlistAndReceive(msg, timeout);
  }

  public close() {
    console.log('Closing LockdownService connections');
    try {
      if (!this.socket.destroyed) {
        this.socket.end();
      }
    } catch (err) {
      console.error('Error closing socket:', err);
    }
  }

  private async getPairRecord(): Promise<PairRecord | null> {
    try {
      console.log('Retrieving pair record for UDID:', this.udid);
      const usbmux = await createUsbmux();
      const record = await usbmux.readPairRecord(this.udid);
      await usbmux.close();
      if (!record?.HostCertificate || !record.HostPrivateKey) {
        console.error('Pair record missing certificate or key');
        return null;
      }
      console.log('Pair record retrieved successfully');
      return record;
    } catch (err) {
      console.error('Error getting pair record for TLS:', err);
      return null;
    }
  }
}

/**
 * Creates a LockdownService, optionally prompting for UDID
 */
export async function createLockdownServiceByUDID(
  udid?: string,
  port = 62078,
  autoSecure = true,
): Promise<LockdownServiceInfo> {
  const usbmux = await createUsbmux();
  console.log('Listing connected devices...');

  const devices = await usbmux.listDevices();
  console.log(
    'Devices:',
    devices.map((d) => d.Properties.SerialNumber),
  );

  await usbmux.close();
  if (devices.length === 0) {
    throw new Error('No devices connected');
  }

  // Determine UDID: use provided if valid, otherwise prompt
  let selectedUDID: string;
  if (udid && devices.some((d) => d.Properties.SerialNumber === udid)) {
    console.log(`Using provided UDID: ${udid}`);
    selectedUDID = udid;
  } else {
    selectedUDID = await promptUserToSelectUDID(devices);
  }

  console.log('Selected UDID:', selectedUDID);

  const device = devices.find(
    (d) => d.Properties.SerialNumber === selectedUDID,
  );
  if (!device) {
    console.error(`UDID ${selectedUDID} not found among connected devices`);
    throw new Error(`UDID ${selectedUDID} not found`);
  }
  console.log(
    `Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`,
  );

  console.log(`Connecting to device ${device.DeviceID} on port ${port}...`);
  const socket: Socket = await connectAndRelay(device.DeviceID, port);
  console.log('Socket connected, creating LockdownService');

  const service = new LockdownService(socket, selectedUDID, autoSecure);
  if (autoSecure && service._tlsUpgrade) {
    console.log('Waiting for TLS upgrade to complete...');
    await service._tlsUpgrade;
  }

  return { lockdownService: service, device };
}
