import { logger } from '@appium/support';
import { Server, Socket, createConnection, createServer } from 'node:net';
import { release } from 'node:os';

import { BaseSocketService } from '../../base-socket-service.js';
import { type PairRecord, processPlistResponse } from '../pair-record/index.js';
import { type RawPairRecordResponse } from '../pair-record/pair-record.js';
import { LengthBasedSplitter, parsePlist } from '../plist/index.js';
import type { PlistDictionary } from '../types.js';
import { type DecodedUsbmux, UsbmuxDecoder } from '../usbmux/usbmux-decoder.js';
import { UsbmuxEncoder } from '../usbmux/usbmux-encoder.js';

/**
 * Interface for device properties
 */
export interface DeviceProperties {
  ConnectionSpeed: number;
  ConnectionType: string;
  DeviceID: number;
  LocationID: number;
  ProductID: number;
  SerialNumber: string;
  USBSerialNumber: string;
}

/**
 * Interface for a device
 */
export interface Device {
  DeviceID: number;
  MessageType: string;
  Properties: DeviceProperties;
}

const log = logger.getLogger('Usbmux');

export const USBMUXD_PORT = 27015;
export const DEFAULT_USBMUXD_SOCKET = '/var/run/usbmuxd';
export const DEFAULT_USBMUXD_HOST = '127.0.0.1';
export const MAX_FRAME_SIZE = 100 * 1024 * 1024; // 1MB

// Result codes from usbmuxd
export const USBMUX_RESULT = {
  OK: 0,
  BADCOMMAND: 1,
  BADDEV: 2,
  CONNREFUSED: 3,
};

// Package info for client identification
const PROG_NAME = 'appium-internal';
const CLIENT_VERSION_STRING = 'appium-internal-1.0.0';

/**
 * Function to swap bytes for a 16-bit value
 * Used for usbmuxd port numbers
 */
export function byteSwap16(value: number): number {
  return ((value & 0xff) << 8) | ((value >> 8) & 0xff);
}

/**
 * Socket options for connecting to usbmuxd
 */
export interface SocketOptions {
  socketPath?: string;
  socketPort?: number;
  socketHost?: string;
  timeout?: number;
}

/**
 * Helper function to check if a file exists
 * @param path - Path to check
 * @returns Boolean indicating if the file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await import('fs').then((fs) => fs.promises.access(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Connects a socket to usbmuxd service
 * @param opts - Connection options
 * @returns Promise that resolves with a socket connected to usbmuxd
 */
export async function getDefaultSocket(
  opts: Partial<SocketOptions> = {},
): Promise<Socket> {
  const defaults = {
    socketPath: DEFAULT_USBMUXD_SOCKET,
    socketPort: USBMUXD_PORT,
    socketHost: DEFAULT_USBMUXD_HOST,
    timeout: 5000,
  };

  if (
    process.env.USBMUXD_SOCKET_ADDRESS &&
    !opts.socketPath &&
    !opts.socketPort &&
    !opts.socketHost
  ) {
    log.debug(
      `Using USBMUXD_SOCKET_ADDRESS environment variable as default socket: ${process.env.USBMUXD_SOCKET_ADDRESS}`,
    );
    // "unix:" or "UNIX:" prefix is optional for unix socket paths.
    const usbmuxdSocketAddress = process.env.USBMUXD_SOCKET_ADDRESS.replace(
      /^(unix):/i,
      '',
    );
    const [ip, port] = usbmuxdSocketAddress.split(':');
    if (ip && port) {
      defaults.socketHost = ip;
      defaults.socketPort = parseInt(port, 10);
    } else {
      defaults.socketPath = usbmuxdSocketAddress;
    }
  }

  const { socketPath, socketPort, socketHost, timeout } = {
    ...defaults,
    ...opts,
  };

  let socket: Socket;
  if (await fileExists(socketPath ?? '')) {
    socket = createConnection(socketPath ?? '');
  } else if (
    process.platform === 'win32' ||
    (process.platform === 'linux' && /microsoft/i.test(release()))
  ) {
    // Connect to usbmuxd when running on WSL1
    socket = createConnection({
      port: socketPort as number,
      host: socketHost as string,
    });
  } else {
    throw new Error(
      `The usbmuxd socket at '${socketPath}' does not exist or is not accessible`,
    );
  }

  return await new Promise<Socket>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.removeAllListeners();
      reject(new Error(`Connection timed out after ${timeout}ms`));
    }, timeout ?? 5000);

    socket.once('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    socket.once('connect', () => {
      clearTimeout(timeoutId);
      resolve(socket);
    });
  });
}

/**
 * usbmux class for communicating with usbmuxd
 */
export class Usbmux extends BaseSocketService {
  private readonly _decoder: UsbmuxDecoder;
  private readonly _splitter: LengthBasedSplitter;
  private readonly _encoder: UsbmuxEncoder;
  private _tag: number;
  private readonly _responseCallbacks: Record<
    number,
    (data: DecodedUsbmux) => void
  >;

  /**
   * Creates a new usbmux instance
   * @param socketClient - Connected socket to usbmuxd
   */
  constructor(socketClient: Socket) {
    super(socketClient);

    this._decoder = new UsbmuxDecoder();
    this._splitter = new LengthBasedSplitter({
      readableStream: socketClient,
      littleEndian: true,
      maxFrameLength: MAX_FRAME_SIZE,
      lengthFieldOffset: 0,
      lengthFieldLength: 4,
      lengthAdjustment: 0,
    });

    this._socketClient.pipe(this._decoder);

    this._encoder = new UsbmuxEncoder();
    this._encoder.pipe(this._socketClient);
    this._assignClientFailureHandlers(this._encoder);

    this._tag = 0;
    this._responseCallbacks = {};
    this._decoder.on('data', this._handleData.bind(this));
  }

  /**
   * Returns the BUID of the host computer from usbmuxd
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the BUID
   */
  async readBUID(timeout = 5000): Promise<string> {
    const { tag, receivePromise } = this._receivePlistPromise<string>(
      timeout,
      (data) => {
        if (data.payload.BUID) {
          return data.payload.BUID as string;
        }
        throw new Error(`Unexpected data: ${JSON.stringify(data)}`);
      },
    );

    this._sendPlist({
      tag,
      payload: {
        MessageType: 'ReadBUID',
        ProgName: PROG_NAME,
        ClientVersionString: CLIENT_VERSION_STRING,
      },
    });

    return await receivePromise;
  }

  /**
   * Reads the pair record of a device, checking local cache first
   * @param udid - Device UDID
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the pair record or null if not found
   */
  async readPairRecord(
    udid: string,
    timeout = 5000,
  ): Promise<PairRecord | null> {
    // Request from usbmuxd if not found in cache
    const { tag, receivePromise } =
      this._receivePlistPromise<PairRecord | null>(timeout, (data) => {
        if (!data.payload.PairRecordData) {
          return null;
        }
        try {
          // Parse the pair record and assert the type
          return processPlistResponse(
            parsePlist(
              data.payload.PairRecordData as Buffer,
            ) as unknown as RawPairRecordResponse,
          );
        } catch (e) {
          throw new Error(`Failed to parse pair record data: ${e}`);
        }
      });

    this._sendPlist({
      tag,
      payload: {
        MessageType: 'ReadPairRecord',
        PairRecordID: udid,
        ProgName: PROG_NAME,
        ClientVersionString: CLIENT_VERSION_STRING,
      },
    });

    return await receivePromise;
  }

  /**
   * Lists all devices connected to the host
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the device list
   */
  async listDevices(timeout = 5000): Promise<Device[]> {
    const { tag, receivePromise } = this._receivePlistPromise<Device[]>(
      timeout,
      (data) => {
        if (data.payload.DeviceList) {
          return data.payload.DeviceList as unknown as Device[];
        }
        throw new Error(`Unexpected data: ${JSON.stringify(data)}`);
      },
    );

    this._sendPlist({
      tag,
      payload: {
        MessageType: 'ListDevices',
        ProgName: PROG_NAME,
        ClientVersionString: CLIENT_VERSION_STRING,
      },
    });

    return await receivePromise;
  }

  /**
   * Looks for a device with the passed udid
   * @param udid - Device UDID
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the device or undefined if not found
   */
  async findDevice(udid: string, timeout = 5000): Promise<Device | undefined> {
    const devices = await this.listDevices(timeout);
    return devices.find((device) => device.Properties.SerialNumber === udid);
  }

  /**
   * Connects to a certain port on the device
   * @param deviceID - Device ID
   * @param port - Port to connect to
   * @param timeout - Timeout in milliseconds
   * @returns Promise that resolves with the connected socket
   */
  async connect(
    deviceID: string | number,
    port: number,
    timeout = 5000,
  ): Promise<Socket> {
    const { tag, receivePromise } = this._receivePlistPromise<Socket>(
      timeout,
      (data) => {
        if (data.payload.MessageType !== 'Result') {
          throw new Error(`Unexpected data: ${JSON.stringify(data)}`);
        }

        if (data.payload.Number === USBMUX_RESULT.OK) {
          this._splitter.shutdown();
          this._socketClient.unpipe(this._splitter);
          this._splitter.unpipe(this._decoder);
          return this._socketClient;
        } else if (data.payload.Number === USBMUX_RESULT.CONNREFUSED) {
          throw new Error(`Connection was refused to port ${port}`);
        } else {
          throw new Error(`Connection failed with code ${data.payload.Number}`);
        }
      },
    );

    this._sendPlist({
      tag,
      payload: {
        MessageType: 'Connect',
        ProgName: PROG_NAME,
        ClientVersionString: CLIENT_VERSION_STRING,
        DeviceID: deviceID,
        PortNumber: byteSwap16(port),
      },
    });

    return await receivePromise;
  }

  /**
   * Closes the current USBMUX connection gracefully.
   * For non-tunnel commands, call this after the operation is complete.
   * For Connect commands (which consume the connection),
   * the caller is responsible for closing the returned socket.
   *
   * @returns Promise that resolves when the socket is closed.
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // If the socket is still open, end it gracefully.
      if (!this._socketClient.destroyed) {
        // End the connection and then destroy it once closed.
        this._socketClient.end((err?: Error) => {
          if (err) {
            log.error(`Error closing usbmux socket: ${err}`);
            this._socketClient.destroy();
            reject(err);
          } else {
            this._socketClient.destroy();
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handles incoming data from the decoder
   * @param data - Decoded data
   * @private
   */
  private _handleData(data: DecodedUsbmux): void {
    const cb = this._responseCallbacks[data.header.tag];
    if (cb) {
      cb(data);
    }
  }

  /**
   * Sends a plist to usbmuxd
   * @param json - JSON object with tag and payload
   * @private
   */
  private _sendPlist(json: { tag: number; payload: PlistDictionary }): void {
    this._encoder.write(json);
  }

  /**
   * Sets up a promise to receive and process a plist response
   * @param timeout - Timeout in milliseconds
   * @param responseCallback - Callback to process the response
   * @returns Object with tag and promise
   * @private
   */
  private _receivePlistPromise<T>(
    timeout = 5000,
    responseCallback: (data: DecodedUsbmux) => T,
  ): { tag: number; receivePromise: Promise<T> } {
    const tag = this._tag++;
    let timeoutId: NodeJS.Timeout;
    const receivePromise = new Promise<T>((resolve, reject) => {
      this._responseCallbacks[tag] = (data) => {
        try {
          // Clear the timeout to prevent it from triggering
          if (timeoutId) {
            clearTimeout(timeoutId);
          }

          // Process the response
          resolve(responseCallback(data));
        } catch (e) {
          reject(e);
        } finally {
          delete this._responseCallbacks[tag];
        }
      };

      // Set the timeout handler
      timeoutId = setTimeout(() => {
        if (this._responseCallbacks[tag]) {
          delete this._responseCallbacks[tag];
          log.warn(
            `Timeout waiting for response with tag ${tag} after ${timeout}ms`,
          );
          reject(
            new Error(
              `Failed to receive any data within the timeout: ${timeout}ms - The device might be busy or unresponsive`,
            ),
          );
        }
      }, timeout);
    });

    // Add cleanup handler when promise is settled
    receivePromise
      .catch(() => {})
      .finally(() => {
        if (this._responseCallbacks[tag]) {
          delete this._responseCallbacks[tag];
        }
      });

    return { tag, receivePromise };
  }
}

/**
 * Creates a new usbmux instance
 * @param opts - Socket options
 * @returns Promise that resolves with a usbmux instance
 */
export async function createUsbmux(
  opts: Partial<SocketOptions> = {},
): Promise<Usbmux> {
  const socket = await getDefaultSocket(opts);
  return new Usbmux(socket);
}

/**
 * RelayService class for tunneling connections through a local TCP server
 */
export class RelayService {
  private readonly deviceID: string | number;
  private readonly devicePort: number;
  private readonly relayPort: number;
  private usbmuxClient: Socket | null;
  private server: Server | null;

  /**
   * Creates a new RelayService instance
   * @param deviceID - The device ID to connect to
   * @param devicePort - The port on the device to connect to
   * @param relayPort - The local port to use for the relay server
   */
  constructor(
    deviceID: string | number,
    devicePort: number,
    relayPort: number = 2222,
  ) {
    this.deviceID = deviceID;
    this.devicePort = devicePort;
    this.relayPort = relayPort;
    this.usbmuxClient = null;
    this.server = null;
  }

  /**
   * Starts the relay service
   * @returns Promise that resolves when the relay is set up
   */
  async start(): Promise<void> {
    log.info(
      `Starting relay to device ${this.deviceID} on port ${this.devicePort}...`,
    );

    // Create a usbmux instance and connect to the device
    const usbmux = await createUsbmux();
    this.usbmuxClient = await usbmux.connect(this.deviceID, this.devicePort);

    // Set up the relay server
    this.server = createServer((localSocket: Socket) => {
      log.debug('🔌 Local client connected to relay!');

      // Set up the bidirectional pipe between local socket and usbmux connection
      if (this.usbmuxClient) {
        localSocket.pipe(this.usbmuxClient).pipe(localSocket);
      }

      // Handle socket events
      localSocket.on('close', () => {
        log.debug('Local connection closed (tunnel remains open).');
      });

      localSocket.on('error', (err: Error) => {
        log.error(`Local socket error: ${err}`);
      });
    });

    // Start the server
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        return reject(new Error('Server not initialized'));
      }

      this.server.listen(this.relayPort, () => {
        log.info(`Relay server running on localhost:${this.relayPort}`);
        resolve();
      });

      this.server.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Connects to the relay service
   * @returns Promise that resolves with a socket connected to the relay
   */
  async connect(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(
        { host: '127.0.0.1', port: this.relayPort },
        () => {
          log.debug('Connected to service via local relay.');
          resolve(socket);
        },
      );

      socket.on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Stops the relay service
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.server) {
        this.server.close((err?: Error) => {
          if (err) {
            log.error(`Error stopping relay server: ${err}`);
            reject(err);
          } else {
            log.info('Relay server stopped');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Connects to a device and sets up a relay service in one operation
 * @param deviceID - The device ID to connect to
 * @param port - The port on the device to connect to
 * @param relayPort - The local port to use for the relay server
 * @returns Promise that resolves with a connected socket
 */
export async function connectAndRelay(
  deviceID: string | number,
  port: number,
  relayPort: number = 2222,
): Promise<Socket> {
  // Create and start the relay service
  const relay = new RelayService(deviceID, port, relayPort);
  let socket: Socket | undefined;

  try {
    // Start the relay
    await relay.start();

    // Connect to the relay
    socket = await relay.connect();
    return socket;
  } finally {
    if (!socket) {
      await relay
        .stop()
        .catch((err) => log.error(`Error stopping relay: ${err}`));
    }
  }
}
