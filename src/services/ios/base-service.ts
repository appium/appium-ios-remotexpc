import type net from 'node:net';

import { getLogger } from '../../lib/logger.js';
import {
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  resolveTunnelService,
} from '../../lib/tunnel/tunnel-service-resolver.js';
import { ServiceConnection } from '../../service-connection.js';

const log = getLogger('BaseService');

/**
 * Interface for service information
 */
export interface Service {
  serviceName: string;
  port: string;
}

/**
 * Base class for iOS services that provides common functionality
 */
export class BaseService {
  protected readonly udid: string;

  /**
   * Creates a new BaseService instance
   * @param udid Device UDID
   */
  constructor(udid: string) {
    this.udid = udid;
  }

  /**
   * Starts a lockdown service without sending a check-in message
   */
  public async startLockdownWithoutCheckin(
    serviceName: string,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    const [host, port] = await this.resolveServiceAddress(serviceName);
    return ServiceConnection.createUsingTCP(host, String(port), options);
  }

  /**
   * Starts a lockdown service with proper check-in
   */
  public async startLockdownService(
    serviceName: string,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    try {
      const connection = await this.startLockdownWithoutCheckin(
        serviceName,
        options,
      );
      const checkin = {
        Label: 'appium-internal',
        ProtocolVersion: '2',
        Request: 'RSDCheckin',
      };

      await connection.sendPlistRequest(checkin);
      return connection;
    } catch (error: unknown) {
      log.error('Error during check-in:', error);
      if (error instanceof Error) {
        log.error('Error message:', error.message);
        log.error('Error stack:', error.stack);
      }
      throw error;
    }
  }

  protected async resolveServiceAddress(
    serviceName: string,
    waitMs: number = DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  ): Promise<[string, number]> {
    const { host, port } = await resolveTunnelService(this.udid, serviceName, {
      waitMs,
    });
    return [host, port];
  }
}

/**
 * Remove any SSL wrapper from the socket so raw binary protocols (DTX)
 * can read/write directly. Both DVT and testmanagerd services require this.
 */
export function stripSSL(socket: net.Socket): void {
  if ('_sslobj' in socket) {
    (socket as any)._sslobj = null;
  }
}

export default BaseService;
