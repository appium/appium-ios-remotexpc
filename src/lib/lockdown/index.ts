import { Socket } from 'node:net';
import tls, { type ConnectionOptions, TLSSocket } from 'node:tls';

import { BasePlistService } from '../../base-plist-service.js';
import { ServiceConnection } from '../../service-connection.js';
import { getLogger } from '../logger.js';
import { type PairRecord } from '../pair-record/index.js';
import { PlistService } from '../plist/plist-service.js';
import { RemoteXpcConnection } from '../remote-xpc/remote-xpc-connection.js';
import type { LockdownDeviceInfo, PlistMessage, PlistValue } from '../types.js';
import { RelayService, createUsbmux } from '../usbmux/index.js';

const log = getLogger('Lockdown');
const tlsManagerLog = getLogger('TLSManager');
const deviceManagerLog = getLogger('DeviceManager');

// Constants
const LABEL = 'appium-internal';
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_LOCKDOWN_PORT = 62078;
const DEFAULT_RELAY_PORT = 2222;
/** RSD service name for lockdownd over a RemoteXPC tunnel (e.g. Apple TV Wi‑Fi). */
const LOCKDOWN_REMOTE_UNTRUSTED = 'com.apple.mobile.lockdown.remote.untrusted';
const TUNNEL_LOCKDOWN_CONNECT_TIMEOUT_MS = 30_000;

// Types and Interfaces
interface DeviceProperties {
  ConnectionSpeed: number;
  ConnectionType: string;
  DeviceID: number;
  LocationID: number;
  ProductID: number;
  SerialNumber: string;
  USBSerialNumber: string;
}

interface Device {
  DeviceID: number;
  MessageType: string;
  Properties: DeviceProperties;
}

interface LockdownServiceInfo {
  lockdownService: LockdownService;
  device: Device;
}

interface SessionInfo {
  sessionID: string;
  enableSessionSSL: boolean;
}

interface StartSessionResponse {
  Request?: string;
  SessionID?: PlistValue;
  EnableSessionSSL?: boolean;
  [key: string]: PlistValue | undefined;
}

interface GetValueResponse {
  Request?: string;
  Error?: PlistValue;
  Value?: PlistValue;
  [key: string]: PlistValue | undefined;
}

interface TLSConfig {
  cert: string;
  key: string;
}

// Error classes for better error handling
class LockdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockdownError';
  }
}

class TLSUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TLSUpgradeError';
  }
}

class DeviceNotFoundError extends Error {
  constructor(udid: string) {
    super(`Device with UDID ${udid} not found`);
    this.name = 'DeviceNotFoundError';
  }
}

// TLS Manager for handling TLS operations
class TLSManager {
  /**
   * Upgrades a socket to TLS
   */
  async upgradeSocketToTLS(
    socket: Socket,
    tlsOptions: Partial<ConnectionOptions> = {},
  ): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      socket.pause();
      tlsManagerLog.debug('Upgrading socket to TLS...');

      const secure = tls.connect(
        {
          socket,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          ...tlsOptions,
        },
        () => {
          tlsManagerLog.info('TLS handshake completed');
          resolve(secure);
        },
      );

      secure.on('error', (err) => {
        tlsManagerLog.error(`TLS socket error: ${err}`);
        reject(new TLSUpgradeError(`TLS socket error: ${err.message}`));
      });

      socket.on('error', (err) => {
        tlsManagerLog.error(`Underlying socket error during TLS: ${err}`);
        reject(new TLSUpgradeError(`Socket error during TLS: ${err.message}`));
      });
    });
  }
}

// Device Manager for handling device operations
class DeviceManager {
  /**
   * Lists all connected devices
   */
  async listDevices(): Promise<Device[]> {
    const usbmux = await createUsbmux();
    try {
      deviceManagerLog.debug('Listing connected devices...');
      const devices = await usbmux.listDevices();
      deviceManagerLog.debug(
        `Found ${devices.length} devices: ${devices.map((d) => d.Properties.SerialNumber).join(', ')}`,
      );
      return devices;
    } finally {
      await this.closeUsbmux(usbmux);
    }
  }

  /**
   * Finds a device by UDID
   */
  async findDeviceByUDID(udid: string): Promise<Device> {
    const devices = await this.listDevices();

    if (!devices || devices.length === 0) {
      throw new LockdownError('No devices connected');
    }

    const device = devices.find((d) => d.Properties.SerialNumber === udid);
    if (!device) {
      throw new DeviceNotFoundError(udid);
    }

    deviceManagerLog.info(
      `Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`,
    );

    return device;
  }

  /**
   * Reads pair record for a device
   */
  async readPairRecord(udid: string): Promise<PairRecord> {
    deviceManagerLog.debug(`Retrieving pair record for UDID: ${udid}`);
    const usbmux = await createUsbmux();

    try {
      const record = await usbmux.readPairRecord(udid);

      if (!record?.HostCertificate || !record.HostPrivateKey) {
        throw new LockdownError('Pair record missing certificate or key');
      }

      deviceManagerLog.info('Pair record retrieved successfully');
      return record;
    } catch (err) {
      deviceManagerLog.error(`Error getting pair record: ${err}`);
      throw err;
    } finally {
      await this.closeUsbmux(usbmux);
    }
  }

  private async closeUsbmux(usbmux: any): Promise<void> {
    try {
      await usbmux.close();
    } catch (err) {
      deviceManagerLog.error(`Error closing usbmux: ${err}`);
    }
  }
}

/**
 * RSD handshake on the remote lockdown TCP socket: RSDCheckin, RSDCheckin echo, StartService.
 */
async function rsdHandshakeLockdownPlistService(
  conn: ServiceConnection,
  plistTimeoutMs: number,
): Promise<void> {
  const checkin: Record<string, PlistValue> = {
    Label: LABEL,
    ProtocolVersion: '2',
    Request: 'RSDCheckin',
  };

  const first = await conn.sendPlistRequest(checkin, plistTimeoutMs);
  if (first.Request !== 'RSDCheckin') {
    throw new LockdownError(
      `Invalid RSDCheckin response: ${JSON.stringify(first)}`,
    );
  }

  const second = await conn.receive(plistTimeoutMs);
  if (!second || second.Request !== 'StartService') {
    throw new LockdownError(
      `Expected StartService after RSDCheckin, got: ${JSON.stringify(second)}`,
    );
  }
  if (second.Error) {
    const desc = second.ErrorDescription ?? 'Unknown error';
    throw new LockdownError(
      `RSD remote lockdown service failed: ${String(second.Error)} — ${desc}`,
    );
  }
}

// Main LockdownService class
export class LockdownService extends BasePlistService {
  private readonly udid: string;
  private tlsService?: PlistService;
  private isTLS = false;
  private tlsUpgradePromise?: Promise<void>;
  private _relayService?: RelayService;
  private readonly tlsManager = new TLSManager();
  private readonly deviceManager = new DeviceManager();

  constructor(socket: Socket, udid: string, autoSecure = true) {
    super(socket);
    this.udid = udid;
    log.info(`LockdownService initialized for UDID: ${udid}`);

    if (autoSecure) {
      this.tlsUpgradePromise = this.tryUpgradeToTLS().catch((err) =>
        log.warn(`Auto TLS upgrade failed: ${err.message}`),
      );
    }
  }

  /**
   * Starts a lockdown session
   */
  async startSession(
    hostID: string,
    systemBUID: string,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<SessionInfo> {
    log.debug(`Starting lockdown session with HostID: ${hostID}`);

    const request: Record<string, PlistValue> = {
      Label: LABEL,
      Request: 'StartSession',
      HostID: hostID,
      SystemBUID: systemBUID,
    };

    const response = (await this.sendAndReceive(
      request,
      timeout,
    )) as StartSessionResponse;

    if (response.Request === 'StartSession' && response.SessionID) {
      const sessionInfo: SessionInfo = {
        sessionID: String(response.SessionID),
        enableSessionSSL: Boolean(response.EnableSessionSSL),
      };

      log.info(`Lockdown session started, SessionID: ${sessionInfo.sessionID}`);
      return sessionInfo;
    }

    throw new LockdownError(
      `Unexpected session data: ${JSON.stringify(response)}`,
    );
  }

  /**
   * Attempts to upgrade the connection to TLS
   */
  async tryUpgradeToTLS(): Promise<void> {
    try {
      const pairRecord = await this.deviceManager.readPairRecord(this.udid);

      if (!this.validatePairRecord(pairRecord)) {
        log.warn('Invalid pair record for TLS upgrade');
        return;
      }

      const sessionInfo = await this.startSession(
        pairRecord.HostID!,
        pairRecord.SystemBUID!,
      );

      if (!sessionInfo.enableSessionSSL) {
        log.info('Device did not request TLS upgrade. Continuing unencrypted.');
        return;
      }

      await this.performTLSUpgrade(pairRecord);
    } catch (err) {
      log.error(`TLS upgrade failed: ${err}`);
      throw err;
    }
  }

  /**
   * Gets the current socket (TLS or regular)
   */
  public getSocket(): Socket | TLSSocket {
    return this.isTLS && this.tlsService
      ? this.tlsService.getSocket()
      : this.getPlistService().getSocket();
  }

  /**
   * Sends a message and receives a response
   */
  public async sendAndReceive(
    msg: Record<string, PlistValue>,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<PlistMessage> {
    const service =
      this.isTLS && this.tlsService ? this.tlsService : this._plistService;
    return service.sendPlistAndReceive(msg, timeout);
  }

  /**
   * Reads the device wall clock unix timestamp (seconds) from lockdownd.
   */
  public async getTimeIntervalSince1970(
    timeout = DEFAULT_TIMEOUT,
  ): Promise<number> {
    const value = await this.getValue<PlistValue>(
      'TimeIntervalSince1970',
      undefined,
      timeout,
    );

    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    throw new LockdownError(
      `Unexpected TimeIntervalSince1970 value type: ${typeof value}`,
    );
  }

  /**
   * Reads device wall clock and converts it to a Date object in UTC.
   * The value is derived from Unix epoch seconds (`TimeIntervalSince1970`).
   */
  public async getDeviceDate(timeout = DEFAULT_TIMEOUT): Promise<Date> {
    const unixSeconds = await this.getTimeIntervalSince1970(timeout);
    return new Date(unixSeconds * 1000);
  }

  /**
   * Reads the device timezone identifier (for example: "Europe/Berlin").
   */
  public async getTimeZone(timeout = DEFAULT_TIMEOUT): Promise<string> {
    const value = await this.getValue<PlistValue>(
      'TimeZone',
      undefined,
      timeout,
    );
    if (typeof value === 'string') {
      return value;
    }
    throw new LockdownError(`Unexpected TimeZone value type: ${typeof value}`);
  }

  /**
   * Reads iOS platform version from lockdownd (`ProductVersion`).
   * Example value: `26.3.1`.
   */
  public async getProductVersion(timeout = DEFAULT_TIMEOUT): Promise<string> {
    const value = await this.getValue<PlistValue>(
      'ProductVersion',
      undefined,
      timeout,
    );
    if (typeof value === 'string') {
      return value;
    }
    throw new LockdownError(
      `Unexpected ProductVersion value type: ${typeof value}`,
    );
  }

  /**
   * Reads all default lockdownd values (same behavior as GetValue with no key/domain).
   * Useful for retrieving broad device information payloads.
   */
  public async getDeviceInfo(
    timeout = DEFAULT_TIMEOUT,
  ): Promise<LockdownDeviceInfo> {
    const value = await this.getValue<PlistValue>(
      undefined,
      undefined,
      timeout,
    );
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as LockdownDeviceInfo;
    }
    throw new LockdownError(
      `Unexpected device info payload type: ${Array.isArray(value) ? 'array' : typeof value}`,
    );
  }

  /**
   * Closes the service and associated resources
   */
  public close(): void {
    log.info('Closing LockdownService connections');

    try {
      this.closeSocket();
      this.stopRelayService();
    } catch (err) {
      log.error(`Error during close: ${err}`);
      throw err;
    }
  }

  /**
   * Sets the relay service for this lockdown instance
   */
  public set relayService(relay: RelayService) {
    this._relayService = relay;
  }

  /**
   * Gets the relay service for this lockdown instance
   */
  public get relayService(): RelayService | undefined {
    return this._relayService;
  }

  /**
   * Waits for TLS upgrade to complete if in progress
   */
  public async waitForTLSUpgrade(): Promise<void> {
    if (this.tlsUpgradePromise) {
      await this.tlsUpgradePromise;
    }
  }

  /**
   * Stops the relay service with an optional custom message
   */
  public stopRelayService(
    message = 'Stopping relay server associated with LockdownService',
  ): void {
    const relay = this.relayService;
    if (relay) {
      log.info(message);
      (async () => {
        try {
          await relay.stop();
          log.info('Relay server stopped successfully');
        } catch (err) {
          log.error(`Error stopping relay server: ${err}`);
        }
      })();
    }
  }

  /**
   * Reads a value from lockdownd using the GetValue request.
   *
   * @param key - Optional value key, e.g. TimeIntervalSince1970
   * @param domain - Optional value domain
   * @param timeout - Request timeout in milliseconds
   */
  private async getValue<T = PlistValue>(
    key?: string,
    domain?: string,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<T> {
    const request: Record<string, PlistValue> = {
      Label: LABEL,
      Request: 'GetValue',
    };

    if (domain) {
      request.Domain = domain;
    }
    if (key) {
      request.Key = key;
    }

    const response = (await this.sendAndReceive(
      request,
      timeout,
    )) as GetValueResponse;

    if (response.Error) {
      throw new LockdownError(
        `Lockdown GetValue failed for key "${key ?? '<all>'}": ${String(response.Error)}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'Value')) {
      throw new LockdownError(
        `Lockdown GetValue missing Value for key "${key ?? '<all>'}"`,
      );
    }

    const value = response.Value as unknown;
    if (
      value &&
      typeof value === 'object' &&
      'data' in (value as Record<string, unknown>)
    ) {
      return (value as { data: unknown }).data as T;
    }
    return value as T;
  }

  private validatePairRecord(record: PairRecord): boolean {
    return Boolean(
      record?.HostCertificate &&
      record.HostPrivateKey &&
      record.HostID &&
      record.SystemBUID,
    );
  }

  private async performTLSUpgrade(pairRecord: PairRecord): Promise<void> {
    const tlsConfig: TLSConfig = {
      cert: pairRecord.HostCertificate!,
      key: pairRecord.HostPrivateKey!,
    };

    const tlsSocket = await this.tlsManager.upgradeSocketToTLS(
      this.getSocket() as Socket,
      tlsConfig,
    );

    this.tlsService = new PlistService(tlsSocket);
    this.isTLS = true;
    log.info('Successfully upgraded connection to TLS');
  }

  private closeSocket(): void {
    if (this.isTLS && this.tlsService) {
      this.tlsService.close();
    } else {
      super.close();
    }
  }
}

// Factory class for creating LockdownService instances
export class LockdownServiceFactory {
  private readonly deviceManager = new DeviceManager();

  /**
   * Creates a LockdownService for a specific device UDID
   */
  async createByUDID(
    udid: string,
    port = DEFAULT_LOCKDOWN_PORT,
    autoSecure = true,
  ): Promise<LockdownServiceInfo> {
    log.info(`Creating LockdownService for UDID: ${udid}`);

    // Find the device
    const device = await this.deviceManager.findDeviceByUDID(udid);

    // Create relay service
    const relay = new RelayService(device.DeviceID, port, DEFAULT_RELAY_PORT);
    await relay.start();

    let service: LockdownService | undefined;
    try {
      // Connect through the relay
      const socket = await relay.connect();
      log.debug('Socket connected, creating LockdownService');

      // Create the lockdown service
      service = new LockdownService(socket, udid, autoSecure);
      service.relayService = relay;

      // Wait for TLS upgrade if enabled
      if (autoSecure) {
        log.debug('Waiting for TLS upgrade to complete...');
        await service.waitForTLSUpgrade();
      }

      return { lockdownService: service, device };
    } catch (err) {
      // Clean up relay on error
      service?.stopRelayService('Stopping relay after failure');
      throw err;
    }
  }
}

/**
 * Lockdown over an RSD tunnel: TCP to `com.apple.mobile.lockdown.remote.untrusted`, then RSD
 * handshake (`RSDCheckin` → echo → `StartService`), then lockdownd plist on a plaintext socket
 * (no usbmux relay TLS). `remoteXpc` is only used to discover the service port.
 *
 * `remoteXpc` must already be connected. It is not closed here.
 */
export async function createLockdownServiceByTunnel(
  remoteXpc: RemoteXpcConnection,
  udid: string,
): Promise<LockdownService> {
  const [host] = remoteXpc.address;

  let lockdownPort: string | undefined;
  try {
    lockdownPort = remoteXpc.findService(LOCKDOWN_REMOTE_UNTRUSTED).port;
  } catch {
    lockdownPort = undefined;
  }
  if (!lockdownPort) {
    throw new LockdownError(
      `RSD has no remote lockdown service (${LOCKDOWN_REMOTE_UNTRUSTED}) for ${udid}`,
    );
  }

  const conn = await ServiceConnection.createUsingTCP(host, lockdownPort, {
    createConnectionTimeout: TUNNEL_LOCKDOWN_CONNECT_TIMEOUT_MS,
  });
  await rsdHandshakeLockdownPlistService(conn, DEFAULT_TIMEOUT);
  return new LockdownService(conn.getSocket(), udid, false);
}

// Export factory function for backward compatibility
export async function createLockdownServiceByUDID(
  udid: string,
  port = DEFAULT_LOCKDOWN_PORT,
  autoSecure = true,
): Promise<LockdownServiceInfo> {
  const factory = new LockdownServiceFactory();
  return factory.createByUDID(udid, port, autoSecure);
}

// Export the TLS upgrade function for external use
export function upgradeSocketToTLS(
  socket: Socket,
  tlsOptions: Partial<ConnectionOptions> = {},
): Promise<TLSSocket> {
  const tlsManager = new TLSManager();
  return tlsManager.upgradeSocketToTLS(socket, tlsOptions);
}
