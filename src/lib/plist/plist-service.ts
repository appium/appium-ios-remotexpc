import { logger } from '@appium/support';
import { Socket } from 'net';
import { TLSSocket } from 'tls';

import type { PlistDictionary } from '../types.js';
import { LengthBasedSplitter } from './length-based-splitter.js';
import { PlistServiceDecoder } from './plist-decoder.js';
import { PlistServiceEncoder } from './plist-encoder.js';

const log = logger.getLogger('Plist');
const errorLog = logger.getLogger('PlistError');

const config = {
  verboseErrorLogging: false,
};

/**
 * Message type for plist communications
 */
type PlistMessage = PlistDictionary;

/**
 * Options for PlistService
 */
export interface PlistServiceOptions {
  maxFrameLength?: number;
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
    this._decoder.on('data', (data: PlistMessage) =>
      this._messageQueue.push(data),
    );

    // Handle errors
    this.setupErrorHandlers();
  }

  /**
   * Send a plist message and receive a response
   * @param data Message to send
   * @param timeout Response timeout in ms
   * @returns Promise resolving to the received message
   */
  public async sendPlistAndReceive(
    data: PlistMessage,
    timeout = 5000,
  ): Promise<PlistMessage> {
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
   * @throws Error if timeout is reached before receiving a message
   */
  public async receivePlist(timeout = 5000): Promise<PlistMessage> {
    return new Promise<PlistMessage>((resolve, reject) => {
      // Check if we already have a message
      const message = this._messageQueue.shift();
      if (message) {
        return resolve(message);
      }

      // Set up a check interval
      const checkInterval = setInterval(() => {
        const message = this._messageQueue.shift();
        if (message) {
          clearInterval(checkInterval);
          clearTimeout(timeoutId);
          resolve(message);
        }
      }, 50);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        reject(
          new Error(`Timed out waiting for plist response after ${timeout}ms`),
        );
      }, timeout);
    });
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
      log.error(
        `Error closing socket: ${error instanceof Error ? error.message : String(error)}`,
      );

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
    if (
      error.message.includes('Invalid XML') ||
      error.message.includes('XML parsing')
    ) {
      errorLog.debug('This might be a binary plist with a non-standard format');
    }
  }
}
