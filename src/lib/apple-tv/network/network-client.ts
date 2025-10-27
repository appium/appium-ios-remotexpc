import { logger } from '@appium/support';
import * as net from 'node:net';

import { NetworkError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import { NETWORK_CONSTANTS } from './constants.js';
import type { NetworkClientInterface } from './types.js';

/** Handles TCP socket communication with Apple TV devices */
export class NetworkClient implements NetworkClientInterface {
  private socket: net.Socket | null = null;
  private readonly log = logger.getLogger('NetworkClient');

  constructor(private readonly config: PairingConfig) {}

  async connect(ip: string, port: number): Promise<void> {
    try {
      this.log.debug(`Connecting to ${ip}:${port}`);

      return new Promise((resolve, reject) => {
        let timeoutId: NodeJS.Timeout | null = null;
        let isResolved = false;

        const resolveOnce = () => {
          if (!isResolved) {
            isResolved = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            resolve();
          }
        };

        const rejectOnce = (error: Error) => {
          if (!isResolved) {
            isResolved = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            this.cleanup();
            reject(error);
          }
        };

        // Create socket without connecting yet
        this.socket = new net.Socket();
        this.socket.setTimeout(this.config.timeout);

        // Attach event listeners BEFORE connecting to avoid race conditions
        this.socket.once('connect', () => {
          this.log.debug('Connected successfully');
          resolveOnce();
        });

        this.socket.once('error', (error) => {
          this.log.error('Connection error:', error);
          rejectOnce(new NetworkError(`Connection failed: ${error.message}`));
        });

        this.socket.once('timeout', () => {
          this.log.error('Socket timeout');
          rejectOnce(new NetworkError('Socket timeout'));
        });

        // Set up timeout for connection attempt
        timeoutId = setTimeout(() => {
          this.log.error('Connection attempt timeout');
          rejectOnce(
            new NetworkError(
              `Connection timeout after ${this.config.timeout}ms`,
            ),
          );
        }, this.config.timeout);

        // Now initiate the connection
        this.socket.connect(port, ip);
      });
    } catch (error) {
      this.cleanup();
      this.log.error('Connect failed:', error);
      throw new NetworkError(
        `Failed to initiate connection: ${(error as Error).message}`,
      );
    }
  }

  async sendPacket(data: any): Promise<void> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    try {
      const packet = this.createRPPairingPacket(data);
      this.log.debug('Sending packet:', { size: packet.length });

      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject(new NetworkError('Socket disconnected during send'));
          return;
        }

        this.socket.write(packet, (error) => {
          if (error) {
            this.log.error('Send packet error:', error);
            reject(new NetworkError('Failed to send packet'));
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      this.log.error('Create packet error:', error);
      throw new NetworkError('Failed to create packet');
    }
  }

  async receiveResponse(): Promise<any> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let expectedLength: number | null = null;
      let headerRead = false;
      let isResolved = false;
      let timeoutId: NodeJS.Timeout | null = null;

      const resolveOnce = (response: any) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(response);
        }
      };

      const rejectOnce = (error: Error) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(error);
        }
      };

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (this.socket) {
          this.socket.removeListener('data', onData);
          this.socket.removeListener('error', onError);
          this.socket.removeListener('close', onClose);
        }
      };

      const onData = (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);

          // Parse header if not yet read
          if (!headerRead && buffer.length >= NETWORK_CONSTANTS.HEADER_LENGTH) {
            const magic = buffer
              .slice(0, NETWORK_CONSTANTS.MAGIC_LENGTH)
              .toString('ascii');
            if (magic !== NETWORK_CONSTANTS.MAGIC) {
              throw new NetworkError(
                `Invalid protocol magic: expected '${NETWORK_CONSTANTS.MAGIC}', got '${magic}'`,
              );
            }
            expectedLength = buffer.readUInt16BE(
              NETWORK_CONSTANTS.MAGIC_LENGTH,
            );
            headerRead = true;
            this.log.debug(
              `Response header parsed: expecting ${expectedLength} bytes`,
            );
          }

          // Parse body if complete
          if (
            headerRead &&
            expectedLength !== null &&
            buffer.length >= NETWORK_CONSTANTS.HEADER_LENGTH + expectedLength
          ) {
            const bodyBytes = buffer.slice(
              NETWORK_CONSTANTS.HEADER_LENGTH,
              NETWORK_CONSTANTS.HEADER_LENGTH + expectedLength,
            );
            const response = JSON.parse(bodyBytes.toString('utf8'));
            this.log.debug('Response received and parsed successfully');
            resolveOnce(response);
          }
        } catch (error) {
          this.log.error('Parse response error:', error);
          rejectOnce(
            new NetworkError(
              `Failed to parse response: ${(error as Error).message}`,
            ),
          );
        }
      };

      const onError = (error: Error) => {
        this.log.error('Socket error during receive:', error);
        rejectOnce(new NetworkError(`Socket error: ${error.message}`));
      };

      const onClose = () => {
        this.log.error('Socket closed unexpectedly during receive');
        rejectOnce(new NetworkError('Socket closed unexpectedly'));
      };

      // Attach listeners BEFORE setting up timeout to avoid race conditions
      if (this.socket) {
        this.socket.on('data', onData);
        this.socket.on('error', onError);
        this.socket.on('close', onClose);

        // Set up timeout after listeners are attached
        timeoutId = setTimeout(() => {
          this.log.error(`Response timeout after ${this.config.timeout}ms`);
          rejectOnce(
            new NetworkError(`Response timeout after ${this.config.timeout}ms`),
          );
        }, this.config.timeout);
      } else {
        rejectOnce(new NetworkError('Socket not available'));
      }
    });
  }

  disconnect(): void {
    this.cleanup();
  }

  private createRPPairingPacket(jsonData: any): Buffer {
    const jsonString = JSON.stringify(jsonData);
    const bodyBytes = Buffer.from(jsonString, 'utf8');
    const magic = Buffer.from(NETWORK_CONSTANTS.MAGIC, 'ascii');
    const length = Buffer.alloc(NETWORK_CONSTANTS.LENGTH_FIELD_SIZE);
    length.writeUInt16BE(bodyBytes.length, 0);
    return Buffer.concat([magic, length, bodyBytes]);
  }

  private cleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}
