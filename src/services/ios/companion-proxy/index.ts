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

function assertGizmoPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new TypeError(`gizmoPort must be an integer in 1..${MAX_PORT}, got ${port}`);
  }
}

/**
 * CompanionProxyService provides an API to:
 * - List paired Apple Watches and stream pair/attach events
 * - Read per-watch registry values
 * - Forward a watch TCP port through the phone and connect to it
 */
class CompanionProxyService extends BaseService implements CompanionProxyServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.companion_proxy.shim.remote';
  private readonly timeout: number;
  private _listenConn: ServiceConnection | null = null;

  constructor(udid: string, timeout: number = DEFAULT_TIMEOUT_MS) {
    super(udid);
    this.timeout = timeout;
  }

  /**
   * List the UDIDs of the watches paired with this phone
   * @returns Paired watch UDIDs; empty when the daemon reports `NoPairedWatches`
   */
  async list(): Promise<string[]> {
    const response = await this.sendCommand({Command: 'GetDeviceRegistry'});
    if (response.Error === 'NoPairedWatches') {
      return [];
    }
    this.throwOnError(response, 'GetDeviceRegistry');
    const udids = response.PairedDevicesArray;
    return Array.isArray(udids) ? udids.map(String) : [];
  }

  /**
   * Stream watch pair/unpair/attach/detach events on a dedicated persistent connection.
   * The daemon cancels the stream on any further input, so nothing else is ever sent on it.
   * @param timeout Milliseconds to wait for each event
   */
  async *listen(timeout: number = DEFAULT_EVENT_TIMEOUT_MS): AsyncGenerator<CompanionDeviceEvent> {
    if (!this._listenConn) {
      this._listenConn = await this.connectToCompanionProxyService();
      this._listenConn.sendPlist({Command: 'StartListeningForDevices'});
    }
    const conn = this._listenConn;
    while (true) {
      const frame = await conn.receive(timeout);
      this.throwOnError(frame, 'StartListeningForDevices');
      if (!isCompanionDeviceEvent(frame)) {
        throw new CompanionProxyError(`Unexpected companion event frame: ${JSON.stringify(frame)}`);
      }
      yield frame;
    }
  }

  /**
   * Read one registry value for a paired watch
   * @param companionUdid Watch UDID from `list()`
   * @param key Registry key, e.g. `DeviceName`, `ProductVersion`, `BatteryCurrentCapacity`
   */
  async getValue(companionUdid: string, key: string): Promise<PlistValue> {
    const response = await this.sendCommand(this.buildGetValueRequest(companionUdid, key));
    this.throwOnError(response, 'GetValueFromRegistry');
    const values = response.RetrievedValueDictionary;
    if (!isPlistDictionary(values)) {
      throw new CompanionProxyError(`Unexpected GetValueFromRegistry reply: ${JSON.stringify(response)}`);
    }
    return values[key];
  }

  /**
   * Ask the phone to forward a watch TCP port; the listener survives until
   * `stopForwardingServicePort()`. Reach it with `connectToForwardedPort()`.
   * @param gizmoPort TCP port on the watch
   * @returns Ephemeral port on the phone proxying to `gizmoPort`
   */
  async startForwardingServicePort(gizmoPort: number, options?: StartForwardingOptions): Promise<number> {
    const response = await this.sendCommand(this.buildStartForwardingRequest(gizmoPort, options));
    this.throwOnError(response, 'StartForwardingServicePort');
    const port = response.CompanionProxyServicePort;
    if (typeof port !== 'number') {
      throw new CompanionProxyError(`Unexpected StartForwardingServicePort reply: ${JSON.stringify(response)}`);
    }
    return port;
  }

  /**
   * Stop forwarding a watch port started with `startForwardingServicePort()`.
   * Accepts Apple's misspelled `ComandSuccess` reply as well as `CommandSuccess`.
   * @param gizmoPort TCP port on the watch (not the phone port returned earlier)
   */
  async stopForwardingServicePort(gizmoPort: number): Promise<void> {
    const response = await this.sendCommand(this.buildStopForwardingRequest(gizmoPort));
    this.throwOnError(response, 'StopForwardingServicePort');
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
   * Close the persistent `listen()` connection, if any
   */
  close(): void {
    try {
      this._listenConn?.close();
    } catch (error) {
      log.error('Error closing companion proxy connection:', error);
    } finally {
      this._listenConn = null;
    }
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
      const greeting = await conn.receive(this.timeout);
      this.throwOnError(greeting, 'StartService');
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

  private throwOnError(response: PlistDictionary, command: string): void {
    if (!response?.Error) {
      return;
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
    gizmoPort: number,
    {serviceName, isServiceLowPriority = false, preferWifi = false, ...options}: StartForwardingOptions = {},
  ): StartForwardingServicePortRequest {
    assertGizmoPort(gizmoPort);
    return {
      Command: 'StartForwardingServicePort',
      GizmoRemotePortNumber: gizmoPort,
      IsServiceLowPriority: isServiceLowPriority,
      PreferWifi: preferWifi,
      ...(serviceName === undefined ? {} : {ForwardedServiceName: serviceName}),
      ...options,
    };
  }

  private buildStopForwardingRequest(gizmoPort: number): StopForwardingServicePortRequest {
    assertGizmoPort(gizmoPort);
    return {
      Command: 'StopForwardingServicePort',
      GizmoRemotePortNumber: gizmoPort,
    };
  }
}

export {CompanionProxyService};
