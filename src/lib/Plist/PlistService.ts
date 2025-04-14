import { Socket } from 'net';
import { TLSSocket } from 'tls';
import PlistServiceEncoder from './PlistEncoder.js';
import PlistServiceDecoder from './PlistDecoder.js';
import LengthBasedSplitter from './LengthBasedSplitter.js';

/**
 * Message type for plist communications
 */
type PlistMessage = Record<string, unknown>;

/**
 * Service for communication using plist protocol
 */
export class PlistService {
    private socket: Socket | TLSSocket;
    private splitter: LengthBasedSplitter;
    private decoder: PlistServiceDecoder;
    private encoder: PlistServiceEncoder;
    private messageQueue: PlistMessage[];

    /**
     * Creates a new PlistService instance
     * @param socket The socket to use for communication
     */
    constructor(socket: Socket) {
        this.socket = socket;

        // Set up transformers
        this.splitter = new LengthBasedSplitter();
        this.decoder = new PlistServiceDecoder();
        this.encoder = new PlistServiceEncoder();

        // Set up the pipeline
        this.setupPipeline();

        // Message queue for async receiving
        this.messageQueue = [];
        this.decoder.on('data', (data: PlistMessage) => this.messageQueue.push(data));

        // Handle errors
        this.setupErrorHandlers();
    }

    /**
     * Sets up the data pipeline between socket and transformers
     */
    private setupPipeline(): void {
        this.socket.pipe(this.splitter).pipe(this.decoder);
        this.encoder.pipe(this.socket);
    }

    /**
     * Sets up error handlers for socket and transformers
     */
    private setupErrorHandlers(): void {
        this.socket.on('error', this.handleError.bind(this));
        this.encoder.on('error', this.handleError.bind(this));
        this.decoder.on('error', this.handleError.bind(this));
        this.splitter.on('error', this.handleError.bind(this));
    }

    /**
     * Handles errors from any component
     * @param error The error that occurred
     */
    private handleError(error: Error): void {
        console.error(`PlistService Error: ${error.message}`);
    }

    /**
     * Send a plist message and receive a response
     * @param data Message to send
     * @param timeout Response timeout in ms
     * @returns Promise resolving to the received message
     */
    public async sendPlistAndReceive(data: PlistMessage, timeout = 5000): Promise<PlistMessage> {
        this.sendPlist(data);
        return this.receivePlist(timeout);
    }

    /**
     * Send a plist message
     * @param data Message to send
     * @throws Error if data is null or undefined
     */
    public sendPlist(data: PlistMessage): void {
        if (!data) {
            throw new Error('Cannot send null or undefined data');
        }
        this.encoder.write(data);
    }

    /**
     * Receive a plist message with timeout
     * @param timeout Timeout in ms
     * @returns Promise resolving to the received message
     * @throws Error if timeout is reached before receiving a message
     */
    public async receivePlist(timeout = 5000): Promise<PlistMessage> {
        return new Promise<PlistMessage>((resolve, reject) => {
            // Check if we already have a message
            const message = this.messageQueue.shift();
            if (message) {
                return resolve(message);
            }

            // Set up a check interval
            const checkInterval = setInterval(() => {
                const message = this.messageQueue.shift();
                if (message) {
                    clearInterval(checkInterval);
                    clearTimeout(timeoutId);
                    resolve(message);
                }
            }, 50);

            // Set up timeout
            const timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error(`Timed out waiting for plist response after ${timeout}ms`));
            }, timeout);
        });
    }

    /**
     * Close the connection and clean up resources
     */
    public close(): void {
        try {
            this.socket.end();
        } catch (error) {
            console.error('Error closing socket:', error instanceof Error ? error.message : String(error));
        }
    }
}

export default PlistService;