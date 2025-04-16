import net, {Socket} from 'net';
import os from 'os';
import {LengthBasedSplitter} from '../Plist/index.js';
import {UsbmuxDecoder} from './usbmux-decoder.js';
import {UsbmuxEncoder} from './usbmux-encoder.js';
import {Transform} from 'stream';
import {type PairRecord, processPlistResponse} from '../PairRecord/index.js';
import {plist} from '@appium/support';

export const USBMUXD_PORT = 27015;
export const LOCKDOWN_PORT = 62078;
export const DEFAULT_USBMUXD_SOCKET = '/var/run/usbmuxd';
export const DEFAULT_USBMUXD_HOST = '127.0.0.1';
export const MAX_FRAME_SIZE = 1 * 1024 * 1024; // 1MB

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
        await import('fs').then(fs => fs.promises.access(path));
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
export async function getDefaultSocket(opts: Partial<SocketOptions> = {}): Promise<Socket> {
    const defaults = {
        socketPath: DEFAULT_USBMUXD_SOCKET,
        socketPort: USBMUXD_PORT,
        socketHost: DEFAULT_USBMUXD_HOST,
        timeout: 5000
    };

    if (process.env.USBMUXD_SOCKET_ADDRESS && !opts.socketPath && !opts.socketPort && !opts.socketHost) {
        console.log(`Using USBMUXD_SOCKET_ADDRESS environment variable as default socket: ${process.env.USBMUXD_SOCKET_ADDRESS}`);
        // "unix:" or "UNIX:" prefix is optional for unix socket paths.
        const usbmuxdSocketAddress = process.env.USBMUXD_SOCKET_ADDRESS.replace(/^(unix):/i, '');
        const [ip, port] = usbmuxdSocketAddress.split(':');
        if (ip && port) {
            defaults.socketHost = ip;
            defaults.socketPort = parseInt(port, 10);
        } else {
            defaults.socketPath = usbmuxdSocketAddress;
        }
    }

    const { socketPath, socketPort, socketHost, timeout } = { ...defaults, ...opts };

    let socket: Socket;
    if (await fileExists(socketPath ?? '')) {
        socket = net.createConnection(socketPath ?? '');
    } else if (process.platform === 'win32'
        || (process.platform === 'linux' && /microsoft/i.test(os.release()))) {
        // Connect to usbmuxd when running on WSL1
        socket = net.createConnection({
            port: socketPort as number,
            host: socketHost as string
        });
    } else {
        throw new Error(`The usbmuxd socket at '${socketPath}' does not exist or is not accessible`);
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
 * Base class for service sockets
 */
export class BaseServiceSocket {
    protected _socketClient: Socket;

    constructor(socketClient: Socket) {
        this._socketClient = socketClient;
    }

    /**
     * Assigns error and close handlers to a stream
     * @param stream - The stream to assign handlers to
     */
    protected _assignClientFailureHandlers(stream: Transform): void {
        if (this._socketClient) {
            this._socketClient.on('error', (e) => {
                console.error(`Socket client error: ${e.message}`);
                stream.emit('error', e);
            });
            this._socketClient.on('close', () => {
                console.log('Socket client closed');
                stream.emit('close');
            });
        }
    }
}

/**
 * Usbmux class for communicating with usbmuxd
 */
export class Usbmux extends BaseServiceSocket {
    private _decoder: UsbmuxDecoder;
    private _splitter: LengthBasedSplitter;
    private _encoder: UsbmuxEncoder;
    private _tag: number;
    private _responseCallbacks: Record<number, (data: any) => void>;

    /**
     * Creates a new Usbmux instance
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
     * Handles incoming data from the decoder
     * @param data - Decoded data
     * @private
     */
    private _handleData(data: any): void {
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
    private _sendPlist(json: { tag: number, payload: Record<string, any> }): void {
        this._encoder.write(json);
    }

    /**
     * Sets up a promise to receive and process a plist response
     * @param timeout - Timeout in milliseconds
     * @param responseCallback - Callback to process the response
     * @returns Object with tag and promise
     * @private
     */
    private _receivePlistPromise(timeout = 5000, responseCallback: (data: any) => any): { tag: number, receivePromise: Promise<any> } {
        const tag = this._tag++;
        let timeoutId: NodeJS.Timeout;
        const receivePromise = new Promise<any>((resolve, reject) => {
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
                    console.warn(`Timeout waiting for response with tag ${tag} after ${timeout}ms`);
                    reject(new Error(`Failed to receive any data within the timeout: ${timeout}ms - The device might be busy or unresponsive`));
                }
            }, timeout);
        });

        // Add cleanup handler when promise is settled
        receivePromise.catch(() => {}).finally(() => {
            if (this._responseCallbacks[tag]) {
                delete this._responseCallbacks[tag];
            }
        });

        return { tag, receivePromise };
    }

    /**
     * Returns the BUID of the host computer from usbmuxd
     * @param timeout - Timeout in milliseconds
     * @returns Promise that resolves with the BUID
     */
    async readBUID(timeout = 5000): Promise<string> {
        const { tag, receivePromise } = this._receivePlistPromise(timeout, (data) => {
            if (data.payload.BUID) {
                return data.payload.BUID;
            }
            throw new Error(`Unexpected data: ${JSON.stringify(data)}`);
        });

        this._sendPlist({
            tag,
            payload: {
                MessageType: 'ReadBUID',
                ProgName: PROG_NAME,
                ClientVersionString: CLIENT_VERSION_STRING
            }
        });

        return await receivePromise;
    }

    /**
     * Reads the pair record of a device, checking local cache first
     * @param udid - Device UDID
     * @param timeout - Timeout in milliseconds
     * @returns Promise that resolves with the pair record or null if not found
     */
    async readPairRecord(udid: string, timeout = 5000): Promise<PairRecord | null> {
        // Request from usbmuxd if not found in cache
        const { tag, receivePromise } = this._receivePlistPromise(timeout, (data) => {
            if (!data.payload.PairRecordData) {
                return null;
            }
            try {
                // Parse the pair record
                return processPlistResponse(plist.parsePlist(data.payload.PairRecordData));
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
                ClientVersionString: CLIENT_VERSION_STRING
            }
        });

        return await receivePromise;
    }

    /**
     * Lists all devices connected to the host
     * @param timeout - Timeout in milliseconds
     * @returns Promise that resolves with the device list
     */
    async listDevices(timeout = 5000): Promise<any[]> {
        const { tag, receivePromise } = this._receivePlistPromise(timeout, (data) => {
            if (data.payload.DeviceList) {
                return data.payload.DeviceList;
            }
            throw new Error(`Unexpected data: ${JSON.stringify(data)}`);
        });

        this._sendPlist({
            tag,
            payload: {
                MessageType: 'ListDevices',
                ProgName: PROG_NAME,
                ClientVersionString: CLIENT_VERSION_STRING
            }
        });

        return await receivePromise;
    }

    /**
     * Looks for a device with the passed udid
     * @param udid - Device UDID
     * @param timeout - Timeout in milliseconds
     * @returns Promise that resolves with the device or undefined if not found
     */
    async findDevice(udid: string, timeout = 5000): Promise<any | undefined> {
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
    async connect(deviceID: string | number, port: number, timeout = 5000): Promise<Socket> {
        const { tag, receivePromise } = this._receivePlistPromise(timeout, (data) => {
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
        });

        this._sendPlist({
            tag,
            payload: {
                MessageType: 'Connect',
                ProgName: PROG_NAME,
                ClientVersionString: CLIENT_VERSION_STRING,
                DeviceID: deviceID,
                PortNumber: byteSwap16(port)
            }
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
        return new Promise((resolve) => {
            // If the socket is still open, end it gracefully.
            if (!this._socketClient.destroyed) {
                // End the connection and then destroy it once closed.
                this._socketClient.end(() => {
                    this._socketClient.destroy();
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

/**
 * Creates a new Usbmux instance
 * @param opts - Socket options
 * @returns Promise that resolves with a Usbmux instance
 */
export async function createUsbmux(opts: Partial<SocketOptions> = {}): Promise<Usbmux> {
    const socket = await getDefaultSocket(opts);
    return new Usbmux(socket);
}

/**
 * RelayService class for tunneling connections through a local TCP server
 */
export class RelayService {
    private deviceID: string | number;
    private devicePort: number;
    private relayPort: number;
    private usbmuxClient: Socket | null;
    private server: net.Server | null;

    /**
     * Creates a new RelayService instance
     * @param deviceID - The device ID to connect to
     * @param devicePort - The port on the device to connect to
     * @param relayPort - The local port to use for the relay server
     */
    constructor(deviceID: string | number, devicePort: number, relayPort: number = 2222) {
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
        console.log(`Starting relay to device ${this.deviceID} on port ${this.devicePort}...`);
        
        // Create a usbmux instance and connect to the device
        const usbmux = await createUsbmux();
        this.usbmuxClient = await usbmux.connect(this.deviceID, this.devicePort);

        // Set up the relay server
        this.server = net.createServer((localSocket) => {
            console.log('🔌 Local client connected to relay!');
            
            // Set up the bidirectional pipe between local socket and usbmux connection
            if (this.usbmuxClient) {
                localSocket.pipe(this.usbmuxClient).pipe(localSocket);
            }

            // Handle socket events
            localSocket.on('close', () => {
                console.log('Local connection closed (tunnel remains open).');
            });
            
            localSocket.on('error', (err) => {
                console.error('Local socket error:', err);
            });
        });

        // Start the server
        await new Promise<void>((resolve, reject) => {
            if (!this.server) {
                return reject(new Error('Server not initialized'));
            }
            
            this.server.listen(this.relayPort, () => {
                console.log(`Relay server running on localhost:${this.relayPort}`);
                resolve();
            });
            
            this.server.on('error', (err) => {
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
            const socket = net.connect({ host: '127.0.0.1', port: this.relayPort }, () => {
                console.log('Connected to service via local relay.');
                resolve(socket);
            });
            
            socket.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * Stops the relay service
     */
    async stop(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('Relay server stopped');
                    resolve();
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
export async function connectAndRelay(deviceID: string | number, port: number, relayPort: number = 2222): Promise<Socket> {
    // Create and start the relay service
    const relay = new RelayService(deviceID, port, relayPort);
    
    try {
        // Start the relay
        await relay.start();
        
        // Connect to the relay
        return await relay.connect();
    } catch (error) {
        // Clean up if there's an error
        await relay.stop().catch(err => console.error('Error stopping relay:', err));
        throw error;
    }
}