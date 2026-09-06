import type {Socket} from 'node:net';

import {util} from '@appium/support';

import {getLogger} from '../../../lib/logger.js';
import {connectViaTunnel} from '../../../lib/port-forwarding/connectors.js';
import type {
  CompanionProxyService as CompanionProxyServiceInterface,
  PlistDictionary,
  PlistValue,
} from '../../../lib/types.js';
import type {ServiceConnection} from '../../../service-connection.js';
import {BaseService} from '../base-service.js';
import {CompanionProxyError} from './errors.js';

const log = getLogger('CompanionProxyService');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_EVENT_TIMEOUT_MS = 120000;
const MAX_PORT = 65535;

export type CompanionDeviceEventCommand = 'GizmoPaired' | 'GizmoUnpaired' | 'GizmoAttach' | 'GizmoDetach';

/**
 * Event frame streamed by `StartListeningForDevices`.
 */
export interface CompanionDeviceEvent extends PlistDictionary {
  Command: CompanionDeviceEventCommand;
  GizmoUDIDKey: string;
  /** Present on `GizmoAttach` for watchOS >= 2 */
  CompanionLockdownProxyPort?: number;
}

/**
 * Options for `StartForwardingServicePort`; any extra keys are merged verbatim into the request.
 */
export interface StartForwardingOptions extends PlistDictionary {
  serviceName?: string;
  isServiceLowPriority?: boolean;
  preferWifi?: boolean;
}

interface GetValueFromRegistryRequest extends PlistDictionary {
  Command: 'GetValueFromRegistry';
  GetValueGizmoUDIDKey: string;
  GetValueKeyKey: string;
}

interface StartForwardingServicePortRequest extends PlistDictionary {
  Command: 'StartForwardingServicePort';
  GizmoRemotePortNumber: number;
  IsServiceLowPriority: boolean;
  PreferWifi: boolean;
  ForwardedServiceName?: string;
}

interface StopForwardingServicePortRequest extends PlistDictionary {
  Command: 'StopForwardingServicePort';
  GizmoRemotePortNumber: number;
}

function isPlistDictionary(value: PlistValue): value is PlistDictionary {
  return util.isPlainObject(value);
}

function isCompanionDeviceEvent(frame: PlistDictionary): frame is CompanionDeviceEvent {
  return typeof frame?.Command === 'string' && typeof frame.GizmoUDIDKey === 'string';
}

/**
 * Validate a watch TCP port and pass it through
 * @throws {TypeError} When `port` is not an integer in 1..65535
 */
function assertWatchPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new TypeError(`watchPort must be an integer in 1..${MAX_PORT}, got ${port}`);
  }
  return port;
}

/**
 * CompanionProxyService provides an API to:
 * - List paired Apple Watches and stream pair/attach events
 * - Read per-watch registry values
 * - Forward a watch TCP port through the phone and connect to it
 */
export class CompanionProxyService extends BaseService implements CompanionProxyServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.companion_proxy.shim.remote';
  private readonly timeout: number;
  private readonly _listenConns = new Set<ServiceConnection>();

  constructor(udid: string, timeout: number = DEFAULT_TIMEOUT_MS) {
    super(udid);
    this.timeout = timeout;
  }

  /**
   * List the UDIDs of the watches paired with this phone
   * @returns Paired watch UDIDs; empty when the daemon reports `NoPairedWatches`
   * @throws {CompanionProxyError} On any other daemon `Error` reply
   */
  async list(): Promise<string[]> {
    const response = await this.sendCommand({Command: 'GetDeviceRegistry'});
    if (response.Error === 'NoPairedWatches') {
      return [];
    }
    const udids = this.throwOnError(response, 'GetDeviceRegistry').PairedDevicesArray;
    return Array.isArray(udids) ? udids.map(String) : [];
  }

  /**
   * Stream watch pair/unpair/attach/detach events on a dedicated connection that is closed
   * when the consumer stops iterating, on error, on `close()`, or when the daemon hangs up.
   * The daemon cancels the stream on any further input, so nothing else is ever sent on it.
   * @param timeout Milliseconds to wait for each event
   * @throws {CompanionProxyError} On a daemon `Error` reply or a frame that is not a companion event
   * @throws {Error} When no event arrives within `timeout` or the connection is closed by either side
   */
  async *listen(timeout: number = DEFAULT_EVENT_TIMEOUT_MS): AsyncGenerator<CompanionDeviceEvent> {
    const conn = await this.connectToCompanionProxyService();
    this._listenConns.add(conn);
    conn.getSocket().once('close', () => this.releaseListenConnection(conn));
    try {
      conn.sendPlist({Command: 'StartListeningForDevices'});
      while (true) {
        const frame = this.throwOnError(await conn.receive(timeout), 'StartListeningForDevices');
        if (!isCompanionDeviceEvent(frame)) {
          throw new CompanionProxyError(`Unexpected companion event frame: ${JSON.stringify(frame)}`);
        }
        yield frame;
      }
    } finally {
      this.releaseListenConnection(conn);
    }
  }

  /**
   * Read one registry value for a paired watch
   * @param companionUdid Watch UDID from `list()`
   * @param key Registry key, e.g. `DeviceName`, `ProductVersion`, `BatteryCurrentCapacity`
   * @throws {CompanionProxyError} On a daemon `Error` reply or a reply without `RetrievedValueDictionary`
   */
  async getValue(companionUdid: string, key: string): Promise<PlistValue> {
    const response = this.throwOnError(
      await this.sendCommand(this.buildGetValueRequest(companionUdid, key)),
      'GetValueFromRegistry',
    );
    const values = response.RetrievedValueDictionary;
    if (!isPlistDictionary(values)) {
      throw new CompanionProxyError(`Unexpected GetValueFromRegistry reply: ${JSON.stringify(response)}`);
    }
    return values[key];
  }

  /**
   * Ask the phone to forward a watch TCP port; the listener survives until
   * `stopForwardingServicePort()`. Reach it with `connectToForwardedPort()`.
   * @param watchPort TCP port on the watch
   * @returns Ephemeral port on the phone proxying to `watchPort`
   * @throws {TypeError} When `watchPort` is not an integer in 1..65535
   * @throws {CompanionProxyError} On a daemon `Error` reply or a reply without `CompanionProxyServicePort`
   */
  async startForwardingServicePort(watchPort: number, options?: StartForwardingOptions): Promise<number> {
    const response = this.throwOnError(
      await this.sendCommand(this.buildStartForwardingRequest(watchPort, options)),
      'StartForwardingServicePort',
    );
    const port = response.CompanionProxyServicePort;
    if (typeof port !== 'number') {
      throw new CompanionProxyError(`Unexpected StartForwardingServicePort reply: ${JSON.stringify(response)}`);
    }
    return port;
  }

  /**
   * Stop forwarding a watch port started with `startForwardingServicePort()`.
   * Accepts Apple's misspelled `ComandSuccess` reply as well as `CommandSuccess`.
   * @param watchPort TCP port on the watch (not the phone port returned earlier)
   * @throws {TypeError} When `watchPort` is not an integer in 1..65535
   * @throws {CompanionProxyError} On a daemon `Error` reply or a reply that is not a success
   */
  async stopForwardingServicePort(watchPort: number): Promise<void> {
    const response = this.throwOnError(
      await this.sendCommand(this.buildStopForwardingRequest(watchPort)),
      'StopForwardingServicePort',
    );
    if (response.Command !== 'ComandSuccess' && response.Command !== 'CommandSuccess') {
      throw new CompanionProxyError(`Unexpected StopForwardingServicePort reply: ${JSON.stringify(response)}`);
    }
  }

  /**
   * Open a raw TCP socket to a phone port returned by `startForwardingServicePort()`.
   * No RSD check-in happens on this socket.
   * @param companionPort Phone port
   */
  async connectToForwardedPort(companionPort: number): Promise<Socket> {
    return await connectViaTunnel(this.udid, companionPort);
  }

  /**
   * Close every open `listen()` stream; their pending receives reject and the generators exit
   */
  close(): void {
    for (const conn of this._listenConns) {
      this.closeListenConnection(conn);
    }
    this._listenConns.clear();
  }

  /**
   * Open a fresh checked-in connection and drain the shim's `StartService` greeting.
   * A greeting carrying `Error` (e.g. `ServiceProhibited`) is surfaced instead of hanging later.
   */
  private async connectToCompanionProxyService(): Promise<ServiceConnection> {
    const conn = await this.startLockdownService(CompanionProxyService.RSD_SERVICE_NAME, {
      createConnectionTimeout: this.timeout,
    });
    try {
      const greeting = this.throwOnError(await conn.receive(this.timeout), 'StartService');
      if (greeting?.Request !== 'StartService') {
        throw new CompanionProxyError(`Expected StartService greeting, got: ${JSON.stringify(greeting)}`);
      }
      return conn;
    } catch (error) {
      conn.close();
      throw error;
    }
  }

  /**
   * Send one command on a fresh connection; the daemon closes after every reply
   */
  private async sendCommand(request: PlistDictionary): Promise<PlistDictionary> {
    const conn = await this.connectToCompanionProxyService();
    try {
      return await conn.sendPlistRequest(request, this.timeout);
    } finally {
      conn.close();
    }
  }

  private closeListenConnection(conn: ServiceConnection): void {
    try {
      conn.close();
    } catch (error) {
      log.error('Error closing companion proxy connection:', error);
    }
  }

  /**
   * Close a `listen()` connection exactly once; rejects its pending receive so the generator exits
   */
  private releaseListenConnection(conn: ServiceConnection): void {
    if (this._listenConns.delete(conn)) {
      this.closeListenConnection(conn);
    }
  }

  /**
   * Throw on a daemon `Error` reply, otherwise pass the response through
   * @throws {CompanionProxyError} Carrying the daemon `Error` code
   */
  private throwOnError<T extends PlistDictionary>(response: T, command: string): T {
    if (!response?.Error) {
      return response;
    }
    const code = String(response.Error);
    const description = response.ErrorDescription ? ` - ${String(response.ErrorDescription)}` : '';
    throw new CompanionProxyError(`${command} failed: ${code}${description}`, code);
  }

  private buildGetValueRequest(companionUdid: string, key: string): GetValueFromRegistryRequest {
    return {
      Command: 'GetValueFromRegistry',
      GetValueGizmoUDIDKey: companionUdid,
      GetValueKeyKey: key,
    };
  }

  private buildStartForwardingRequest(
    watchPort: number,
    {serviceName, isServiceLowPriority = false, preferWifi = false, ...options}: StartForwardingOptions = {},
  ): StartForwardingServicePortRequest {
    return {
      Command: 'StartForwardingServicePort',
      GizmoRemotePortNumber: assertWatchPort(watchPort),
      IsServiceLowPriority: isServiceLowPriority,
      PreferWifi: preferWifi,
      ...(serviceName === undefined ? {} : {ForwardedServiceName: serviceName}),
      ...options,
    };
  }

  private buildStopForwardingRequest(watchPort: number): StopForwardingServicePortRequest {
    return {
      Command: 'StopForwardingServicePort',
      GizmoRemotePortNumber: assertWatchPort(watchPort),
    };
  }
}
