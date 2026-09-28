import {type Socket} from 'node:net';
import {type TLSSocket} from 'node:tls';

import {getLogger} from '../logger.js';
import type {PlistDictionary} from '../types.js';
import {LengthBasedSplitter} from './length-based-splitter.js';
import {PlistServiceDecoder} from './plist-decoder.js';
import {PlistServiceEncoder} from './plist-encoder.js';

const log = getLogger('Plist');
const errorLog = getLogger('PlistError');

const config = {
  verboseErrorLogging: false,
};

/**
 * Options for PlistService
 */
export interface PlistServiceOptions {
  maxFrameLength?: number;
}

/**
 * Message type for plist communications
 */
type PlistMessage = PlistDictionary;

interface PlistWaiter {
  resolve: (message: PlistMessage) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Service for communication using plist protocol
 */
export class PlistService {
  /**
   * Enable verbose error logging
   */
  static enableVerboseErrorLogging(): void {
    config.verboseErrorLogging = true;
    errorLog.debug('Verbose plist error logging enabled');
  }

  /**
   * Disable verbose error logging
   */
  static disableVerboseErrorLogging(): void {
    config.verboseErrorLogging = false;
  }

  /**
   * Check if verbose error logging is enabled
   * @returns True if verbose error logging is enabled
   */
  static isVerboseErrorLoggingEnabled(): boolean {
    return config.verboseErrorLogging;
  }

  /**
   * Gets the underlying socket
   * @returns The socket used by this service
   */
  public getSocket(): Socket | TLSSocket {
    return this._socket;
  }
  private readonly _socket: Socket | TLSSocket;
  private readonly _splitter: LengthBasedSplitter;
  private readonly _decoder: PlistServiceDecoder;
  private _encoder: PlistServiceEncoder;
  private _messageQueue: PlistMessage[];
  private _waiters: PlistWaiter[];

  /**
   * Creates a new PlistService instance
   * @param socket The socket to use for communication
   * @param options Configuration options
   */
  constructor(socket: Socket, options: PlistServiceOptions = {}) {
    this._socket = socket;

    // Set up transformers
    this._splitter = new LengthBasedSplitter({
      maxFrameLength: options.maxFrameLength ?? 100 * 1024 * 1024, // Default to 100MB
    });
    this._decoder = new PlistServiceDecoder();
    this._encoder = new PlistServiceEncoder();

    // Set up the pipeline
    this.setupPipeline();

    // Message queue for async receiving
    this._messageQueue = [];
    this._waiters = [];
    this._decoder.on('data', (data: PlistMessage) => {
      const waiter = this._waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeoutId);
        waiter.resolve(data);
        return;
      }
      this._messageQueue.push(data);
    });

    // Handle errors
    this.setupErrorHandlers();
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
    this._encoder.write(data);
  }

  /**
   * Receive a plist message with timeout
   * @param timeout Timeout in ms
   * @returns Promise resolving to the received message
   * @throws Error if the timeout is reached, or if close() is called before a message arrives
   */
  public async receivePlist(timeout = 5000): Promise<PlistMessage> {
    return new Promise<PlistMessage>((resolve, reject) => {
      const message = this._messageQueue.shift();
      if (message) {
        return resolve(message);
      }

      const waiter: PlistWaiter = {
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          const index = this._waiters.indexOf(waiter);
          if (index !== -1) {
            this._waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for plist response after ${timeout}ms`));
        }, timeout),
      };

      this._waiters.push(waiter);
    });
  }

  /**
   * Stops exchanging plist messages on the socket and returns it, so another
   * protocol can take over the same connection (e.g. AFC after a House Arrest
   * vend).
   *
   * The socket is unpiped from the plist transformers, so they no longer
   * consume its data, and any bytes they buffered are put back into it. Pending
   * receives are rejected. The socket is returned paused, so no data is lost
   * before the new owner attaches its reader; the new owner must `resume()` it
   * after that, since adding a `'data'` listener does not resume an explicitly
   * paused stream.
   *
   * @returns The paused socket, ready to be read by the new owner
   */
  public detachSocket(): Socket | TLSSocket {
    // Unpipe before removing listeners: the pipes' own 'unpipe' handlers take
    // their 'data' listener off the socket, which would otherwise keep feeding
    // every byte into the splitter
    this._socket.unpipe(this._splitter);
    this._splitter.unpipe(this._decoder);
    this._encoder.unpipe(this._socket);
    this._splitter.removeAllListeners();
    this._decoder.removeAllListeners();

    this._messageQueue = [];
    for (const waiter of this._waiters.splice(0)) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('The socket was detached while waiting for a plist response'));
    }

    const bufferedData = this._splitter.takeBufferedData();
    if (bufferedData.length > 0) {
      this._socket.unshift(bufferedData);
    }
    return this._socket;
  }

  /**
   * Close the connection and clean up resources
   */
  public close(): void {
    try {
      // Remove all data listeners to prevent parsing during close
      this._splitter.removeAllListeners();
      this._decoder.removeAllListeners();

      // Clear the message queue to prevent processing during close
      this._messageQueue = [];

      for (const waiter of this._waiters.splice(0)) {
        clearTimeout(waiter.timeoutId);
        waiter.reject(new Error('Connection closed while waiting for plist response'));
      }

      // Unpipe the transformers to prevent data flow during close
      try {
        this._socket.unpipe(this._splitter);
        this._splitter.unpipe(this._decoder);
      } catch (unpipeError) {
        log.debug(
          `Non-critical error during unpipe: ${unpipeError instanceof Error ? unpipeError.message : String(unpipeError)}`,
        );
      }

      // End the socket
      this._socket.end();
    } catch (error) {
      // Log the error but don't rethrow it to ensure cleanup completes
      log.error(`Error closing socket: ${error instanceof Error ? error.message : String(error)}`);

      // If ending fails, destroy the socket
      this._socket.destroy();
    }
  }

  /**
   * Sets up the data pipeline between socket and transformers
   */
  private setupPipeline(): void {
    this._socket.pipe(this._splitter);
    this._splitter.pipe(this._decoder);
    this._encoder.pipe(this._socket);
  }

  /**
   * Sets up error handlers for socket and transformers
   */
  private setupErrorHandlers(): void {
    this._socket.on('error', this.handleError.bind(this));
    this._encoder.on('error', this.handleError.bind(this));
    this._decoder.on('error', this.handleError.bind(this));
    this._splitter.on('error', this.handleError.bind(this));
  }

  /**
   * Handles errors from any component
   * @param error The error that occurred
   */
  private handleError(error: Error): void {
    // Only log detailed errors if verbose logging is enabled
    if (!config.verboseErrorLogging) {
      return;
    }

    errorLog.debug(`PlistService Error: ${error.message}`);

    // If this is an XML parsing error, it might be a binary plist
    if (error.message.includes('Invalid XML') || error.message.includes('XML parsing')) {
      errorLog.debug('This might be a binary plist with a non-standard format');
    }
  }
}
