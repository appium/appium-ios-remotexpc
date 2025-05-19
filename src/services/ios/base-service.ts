import { logger } from '@appium/support';

import { ServiceConnection } from '../../service-connection.js';

const log = logger.getLogger('BaseService');

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
  protected readonly address: [string, number];

  /**
   * Creates a new BaseService instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    this.address = address;
  }

  /**
   * Starts a lockdown service without sending a check-in message
   * @param service Service information
   * @param options Additional options for the connection
   * @returns Promise resolving to a ServiceConnection
   */
  public async startLockdownWithoutCheckin(
    service: Service,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    // Get the port for the requested service
    const port = service.port;
    return ServiceConnection.createUsingTCP(this.address[0], port, options);
  }

  /**
   * Starts a lockdown service with proper check-in
   * @param service Service information
   * @param options Additional options for the connection
   * @returns Promise resolving to a ServiceConnection
   */
  public async startLockdownService(
    service: Service,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    try {
      const connection = await this.startLockdownWithoutCheckin(
        service,
        options,
      );
      const checkin = {
        Label: 'appium-internal',
        ProtocolVersion: '2',
        Request: 'RSDCheckin',
      };

      const response = await connection.sendPlistRequest(checkin);
      log.debug(
        `Service check-in response: ${JSON.stringify(response, null, 2)}`,
      );
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
}

export default BaseService;
