import { Socket } from 'node:net';
import tls, { TLSSocket, type ConnectionOptions } from 'tls';
import { getPairRecord, type PairRecord } from '../PairRecord/index.js';
import { BasePlistService } from '../../BasePlistService.js';
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
    }
}


interface LockdownServiceInfo {
    lockdownService: LockdownService;
    device: Device;
}
/**
 * Upgrades a socket to TLS with careful handling of socket state and events
 */
export function upgradeSocketToTLS(
    socket: Socket,
    tlsOptions: Partial<ConnectionOptions> = {}
): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
        socket.pause();

        const secureSocket: TLSSocket = tls.connect({
            socket,
            ...tlsOptions,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2'
        }, () => {
            resolve(secureSocket);
        });

        secureSocket.on('error', (err) => {
            console.error('TLS socket error:', err);
            if (!secureSocket.authorized) {
                reject(err);
            }
        });

        socket.on('error', (err) => {
            console.error('Underlying socket error during TLS:', err);
            reject(err);
        });
    });
}

/**
 * Improved LockdownService with careful TLS upgrade handling
 */
export class LockdownService extends BasePlistService {
    private socket: Socket | TLSSocket;
    private udid: string;
    public _tlsUpgrade?: Promise<void>;
    private _plistServiceAfterTLS?: PlistService;
    private _isUsingTLS: boolean = false;

    constructor(socket: Socket, udid: string, autoSecure: boolean = true) {
        super(socket);
        this.socket = socket;
        this.udid = udid;

        if (autoSecure) {
            this._tlsUpgrade = this.tryUpgradeToTLS().catch(err => {
                console.warn('Auto TLS upgrade failed:', err.message);
            });
        }
    }

    /**
     * Starts a lockdown session
     */
    async startSession(hostID: string, systemBUID: string, timeout: number = 5000): Promise<any> {
        console.log('Starting lockdown session with HostID:', hostID);

        const data = await this.sendAndReceive({
            Label: LABEL,
            Request: 'StartSession',
            HostID: hostID,
            SystemBUID: systemBUID
        }, timeout);

        if (data.Request === 'StartSession' && data.SessionID) {
            return {
                sessionID: data.SessionID,
                enableSessionSSL: data.EnableSessionSSL
            };
        } else {
            throw new Error(`Unexpected session data: ${JSON.stringify(data)}`);
        }
    }

    /**
     * Gets the pair record for TLS upgrade with better error handling
     */
    private async getPairRecordForTLS(): Promise<PairRecord | null> {
        try {
            let pairRecord = await getPairRecord(this.udid);
            if (!pairRecord) {
                console.log('Cached pair record not found. Requesting it from usbmuxd...');

                const usbmux = await createUsbmux();

                // Retrieve the pair record from the device.
                pairRecord = await usbmux.readPairRecord(this.udid);

                if (!pairRecord) {
                    console.error('Failed to retrieve pair record from usbmuxd');
                    return null;
                }
            }

            if (!pairRecord.HostCertificate || !pairRecord.HostPrivateKey) {
                console.error('Pair record is missing required certificates');
                return null;
            }

            return pairRecord;
        } catch (error) {
            console.error(
                'Error getting pair record for TLS:',
                error instanceof Error ? error.message : String(error)
            );
            return null;
        }
    }

    /**
     * Upgraded TLS implementation with better error handling
     */
    async tryUpgradeToTLS(): Promise<void> {
        const pairRecord = await this.getPairRecordForTLS();
        if (
            !pairRecord ||
            !pairRecord.HostCertificate ||
            !pairRecord.HostPrivateKey ||
            !pairRecord.HostID ||
            !pairRecord.SystemBUID
        ) {
            console.warn('Missing required certificates or session info for TLS upgrade');
            return;
        }

        try {
            const sessionResponse = await this.startSession(pairRecord.HostID, pairRecord.SystemBUID);

            if (!sessionResponse.enableSessionSSL) {
                console.log('Device did not request TLS upgrade. Continuing with unencrypted connection.');
                return;
            }
        } catch (error) {
            console.error('Failed to start session:', error instanceof Error ? error.message : String(error));
            throw error;
        }

        try {
            const tlsSocket = await upgradeSocketToTLS(this.socket as Socket, {
                cert: pairRecord.HostCertificate,
                key: pairRecord.HostPrivateKey
            });

            this.socket = tlsSocket;

            this._plistServiceAfterTLS = new PlistService(tlsSocket);
            this._isUsingTLS = true;

            console.log('Successfully upgraded connection to TLS');
        } catch (error) {
            console.error('Failed to upgrade to TLS:', error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    /**
     * Returns the current socket
     */
    public getSocket(): Socket | TLSSocket {
        return this.socket;
    }

    /**
     * Sends a message and waits for a response, using the appropriate service
     */
    public async sendAndReceive(message: Record<string, unknown>, timeout: number = 5000): Promise<Record<string, unknown>> {
        if (this._isUsingTLS && this._plistServiceAfterTLS) {
            // eslint-disable-next-line no-useless-catch
            try {
                const response = await this._plistServiceAfterTLS.sendPlistAndReceive(message, timeout);
                return response;
            } catch (error) {
                throw error;
            }
        } else {
            return this._plistService.sendPlistAndReceive(message, timeout);
        }
    }

    /**
     * Closes connections with proper cleanup
     */
    public close(): void {
        console.log('Closing LockdownService connections');

        try {
            if (this.socket && !this.socket.destroyed) {
                this.socket.end();
            }
        } catch (error) {
            console.error('Error closing socket:', error);
        }
    }
}

/**
 * Creates a LockdownService for a specific device
 */
export async function createLockdownServiceByUDID(
    udid: string,
    port: number = 62078,
    autoSecure: boolean = true
): Promise<LockdownServiceInfo> {
    try {
        console.log(`Initializing usbmux to find device with UDID: ${udid}`);
        const usbmux = await createUsbmux();
        console.log('Listing connected devices...');
        const devices = await usbmux.listDevices();
        console.log(devices);
        await usbmux.close();

        if (devices.length === 0) {
            throw new Error('No devices found. Make sure your device is connected and has been trusted on this computer.');
        }

        console.log(`Found ${devices.length} connected device(s):`);
        for (const d of devices) {
            console.log(`- DeviceID: ${d.DeviceID}, Type: ${d.Properties.ConnectionType}, SerialNumber: ${d.Properties.SerialNumber}`);
        }

        const device = devices.find(device => device.Properties.SerialNumber === udid);
        if (!device) {
            console.error(`Device with UDID ${udid} not found in the list of connected devices`);
            console.error('Available UDIDs: ' + devices.map(d => d.Properties.SerialNumber).join(', '));
            throw new Error(`Device with UDID ${udid} not found. Please check the UDID and ensure the device is connected.`);
        }

        console.log(`Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`);
        console.log(`Connecting to device ${device.DeviceID} on port ${port}...`);
        const socket: Socket = await connectAndRelay(device.DeviceID, port);

        console.log('Socket connected, creating LockdownService');
        const lockdownService = new LockdownService(socket, udid, autoSecure);

        if (autoSecure && lockdownService._tlsUpgrade) {
            console.log('Waiting for TLS upgrade to complete...');
            await lockdownService._tlsUpgrade;
        }

       return { lockdownService, device };

    } catch (error) {
        console.error(`Error creating lockdown service for UDID ${udid}:`, error);
        throw error;
    }
}