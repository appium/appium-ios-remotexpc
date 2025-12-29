import net from 'node:net';

import { getLogger } from '../../../lib/logger.js';
import AfcService from '../afc/index.js';
import { BaseService } from '../base-service.js';

const log = getLogger('HouseArrestService');

const VEND_CONTAINER = 'VendContainer';
const VEND_DOCUMENTS = 'VendDocuments';

/**
 * House Arrest service for accessing application containers over RSD.
 */
export class HouseArrestService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.house_arrest.shim.remote';

  /**
   * Vend into the application container and return an AfcService.
   *
   * @param bundleId - The bundle identifier of the application
   * @returns Promise resolving to an AfcService operating on the app container
   * @throws Error if the application is not installed, not developer-installed, or vending fails
   */
  async vendContainer(bundleId: string): Promise<AfcService> {
    return this._vend(bundleId, VEND_CONTAINER);
  }

  /**
   * Vend into the application documents directory and return an AfcService.
   *
   * @param bundleId - The bundle identifier of the application
   * @returns Promise resolving to an AfcService
   * @throws Error if the application is not installed, doesn't support file sharing, or vending fails
   */
  async vendDocuments(bundleId: string): Promise<AfcService> {
    return this._vend(bundleId, VEND_DOCUMENTS);
  }

  /**
   * Internal method to perform the vend operation and transition to AFC protocol.
   *
   * @param bundleId - The bundle identifier
   * @param command - Either VendContainer or VendDocuments
   * @returns Promise resolving to an AfcService
   * @private
   */
  private async _vend(bundleId: string, command: string): Promise<AfcService> {
    log.debug(`Vending into ${bundleId} with command: ${command}`);

    const service = this.getServiceConfig();
    const connection = await this.startLockdownService(service);

    try {
      // receive StartService response
      const startServiceResponse = await connection.receive();
      if (startServiceResponse?.Request !== 'StartService') {
        log.warn(
          `Expected StartService response, got: ${JSON.stringify(startServiceResponse)}`,
        );
      }

      const response = await connection.sendPlistRequest({
        Command: command,
        Identifier: bundleId,
      });

      const error = response.Error;
      if (error) {
        if (error === 'ApplicationLookupFailed') {
          throw new Error(`Application not installed: ${bundleId}`);
        }
        if (error === 'InstallationLookupFailed') {
          if (command === VEND_DOCUMENTS) {
            throw new Error(
              `VendDocuments failed for ${bundleId}. This app may not have iTunes File Sharing enabled (UIFileSharingEnabled). Try using vendContainer() instead.`,
            );
          }
        }
        throw new Error(`House Arrest vend failed: ${error}`);
      }

      if (response.Status !== 'Complete') {
        throw new Error(
          `House Arrest vend failed with status: ${response.Status}`,
        );
      }

      log.debug(`Successfully vended into ${bundleId}`);

      const socket = connection.getSocket();

      return this._createAfcServiceFromSocket(socket);
    } catch (error) {
      try {
        connection.close();
      } catch {}
      throw error;
    }
  }

  /**
   * Create an AfcService from a socket that's ready for AFC communication.
   *
   * After the house arrest vend operation succeeds, the socket transitions
   * from plist protocol to raw AFC protocol.
   *
   * @param socket - The socket in AFC mode
   * @returns AfcService instance
   * @private
   */
  private _createAfcServiceFromSocket(socket: net.Socket): AfcService {
    const remoteAddress = socket.remoteAddress || 'localhost';
    const remotePort = socket.remotePort || 0;

    const afcService = new AfcService([remoteAddress, remotePort]);

    (afcService as any).socket = socket;

    return afcService;
  }

  private getServiceConfig(): { serviceName: string; port: string } {
    return {
      serviceName: HouseArrestService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }
}

export default HouseArrestService;
