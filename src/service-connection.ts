import net from 'node:net';

import { BasePlistService } from './base-plist-service.js';
import type { PlistServiceOptions } from './lib/plist/plist-service.js';
import type { PlistDictionary } from './lib/types.js';

export interface ServiceConnectionOptions {
  keepAlive?: boolean;
  createConnectionTimeout?: number;
  plistOptions?: PlistServiceOptions;
}

/**
 * ServiceConnection for communicating with Apple device services over TCP
 */
export class ServiceConnection extends BasePlistService {
  constructor(socket: net.Socket, options?: ServiceConnectionOptions) {
    super(socket, options?.plistOptions);
  }

  /**
   * Creates a TCP connection to the specified host and port
   */
  static createUsingTCP(
    hostname: string,
    port: string,
    options?: ServiceConnectionOptions,
  ): Promise<ServiceConnection> {
    const keepAlive = options?.keepAlive ?? true;
    const createConnectionTimeout = options?.createConnectionTimeout ?? 30000;

    return new Promise<ServiceConnection>((resolve, reject) => {
      const socket = net.createConnection(
        { host: hostname, port: Number(port) },
        () => {
          socket.setTimeout(0);
          if (keepAlive) {
            socket.setKeepAlive(true);
          }
          resolve(new ServiceConnection(socket, options));
        },
      );

      socket.setTimeout(createConnectionTimeout, () => {
        socket.destroy();
        reject(new Error('Connection timed out'));
      });

      socket.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Sends a plist request to the device and returns the response
   */
  sendPlistRequest(
    requestObj: PlistDictionary,
    timeout = 10000,
  ): Promise<PlistDictionary> {
    return this.sendAndReceive(requestObj, timeout);
  }

  /**
   * Sends a plist message without waiting for a response
   * This is useful for fire-and-forget style communication
   * @param message The message to send
   */
  sendPlist(message: PlistDictionary): void {
    this.send(message);
  }

  /**
   * Gets the underlying socket
   * @returns The socket used by this service
   */
  getSocket(): net.Socket {
    return this.getPlistService().getSocket() as net.Socket;
  }

  /**
   * Closes the connection
   */
  close(): void {
    super.close();
  }
}

export default ServiceConnection;
