import { logger } from '@appium/support';
import * as net from 'node:net';

import { NetworkError } from '../errors.js';
import type { PairingConfig } from '../types.js';
import { NETWORK_CONSTANTS } from './constants.js';
import type { NetworkClientInterface } from './types.js';

const log = logger.getLogger('NetworkClient');

/** Handles TCP socket communication with Apple TV devices */
export class NetworkClient implements NetworkClientInterface {
  private socket: net.Socket | null = null;
  private connectionTimeoutId: NodeJS.Timeout | null = null;

  constructor(private readonly config: PairingConfig) {}

  async connect(ip: string, port: number): Promise<void> {
    log.debug(`Connecting to ${ip}:${port}`);

    return new Promise((resolve, reject) => {
      const cancelTimeout = () => {
        if (this.connectionTimeoutId) {
          clearTimeout(this.connectionTimeoutId);
          this.connectionTimeoutId = null;
        }
      };

      this.socket = new net.Socket();
      this.socket.setTimeout(this.config.timeout);

      this.socket.once('connect', () => {
        log.debug('Connected successfully');
        cancelTimeout();
        resolve();
      });

      this.socket.once('error', (error) => {
        log.error('Connection error:', error);
        cancelTimeout();
        reject(new NetworkError(`Connection failed: ${error.message}`));
      });

      this.socket.once('timeout', () => {
        log.error('Socket timeout');
        cancelTimeout();
        reject(new NetworkError('Socket timeout'));
      });

      this.socket.once('close', () => {
        cancelTimeout();
      });

      this.connectionTimeoutId = setTimeout(() => {
        log.error('Connection attempt timeout');
        this.cleanup();
        reject(
          new NetworkError(`Connection timeout after ${this.config.timeout}ms`),
        );
      }, this.config.timeout);

      this.socket.connect(port, ip);
    });
  }

  async sendPacket(data: any): Promise<void> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    const packet = this.createRPPairingPacket(data);
    log.debug('Sending packet:', { size: packet.length });

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new NetworkError('Socket disconnected during send'));
        return;
      }

      this.socket.write(packet, (error) => {
        if (error) {
          log.error('Send packet error:', error);
          reject(new NetworkError('Failed to send packet'));
        } else {
          resolve();
        }
      });
    });
  }

  async receiveResponse(): Promise<any> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let expectedLength: number | null = null;
      let headerRead = false;
      let timeoutId: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (this.socket) {
          this.socket.removeListener('data', onData);
          this.socket.removeListener('error', onError);
        }
      };

      const onData = (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);

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
            log.debug(
              `Response header parsed: expecting ${expectedLength} bytes`,
            );
          }

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
            log.debug('Response received and parsed successfully');
            cleanup();
            resolve(response);
          }
        } catch (error) {
          log.error('Parse response error:', error);
          cleanup();
          reject(
            new NetworkError(
              `Failed to parse response: ${(error as Error).message}`,
            ),
          );
        }
      };

      const onError = (error: Error) => {
        log.error('Socket error during receive:', error);
        cleanup();
        reject(new NetworkError(`Socket error: ${error.message}`));
      };

      const onClose = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      if (this.socket) {
        this.socket.once('data', onData);
        this.socket.once('error', onError);
        this.socket.once('close', onClose);

        timeoutId = setTimeout(() => {
          log.error(`Response timeout after ${this.config.timeout}ms`);
          cleanup();
          reject(
            new NetworkError(`Response timeout after ${this.config.timeout}ms`),
          );
        }, this.config.timeout);
      } else {
        reject(new NetworkError('Socket not available'));
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
    if (this.connectionTimeoutId) {
      clearTimeout(this.connectionTimeoutId);
      this.connectionTimeoutId = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}
