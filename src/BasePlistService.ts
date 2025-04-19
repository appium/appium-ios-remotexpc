import { Socket } from 'node:net';

import { PlistService } from './lib/Plist/PlistService.js';

/**
 * Message type for plist communications
 */
type PlistMessage = Record<string, unknown>;

/**
 * Base class for services that use PlistService for communication
 */
export abstract class BasePlistService {
  /**
   * Closes the underlying connection
   */
  public close(): void {
    this._plistService.close();
  }

  /**
   * The underlying PlistService instance
   */
  protected _plistService: PlistService;

  /**
   * Creates a new BasePlistService
   * @param plistServiceOrSocket
   */
  protected constructor(plistServiceOrSocket: PlistService | Socket) {
    if (plistServiceOrSocket instanceof PlistService) {
      this._plistService = plistServiceOrSocket;
    } else {
      this._plistService = new PlistService(plistServiceOrSocket);
    }
  }

  /**
   * Sends a message and waits for a response
   * @param message The message to send
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the response
   */
  async sendAndReceive(
    message: PlistMessage,
    timeout?: number,
  ): Promise<PlistMessage> {
    return this._plistService.sendPlistAndReceive(message, timeout);
  }

  /**
   * Sends a message without waiting for a response
   * @param message The message to send
   */
  protected send(message: PlistMessage): void {
    this._plistService.sendPlist(message);
  }

  /**
   * Waits for a message
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the received message
   */
  protected async receive(timeout?: number): Promise<PlistMessage> {
    return this._plistService.receivePlist(timeout);
  }
}
