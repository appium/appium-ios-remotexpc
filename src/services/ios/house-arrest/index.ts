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

      const { Error: error, Status: status } = response;

      if (error === 'ApplicationLookupFailed') {
        throw new Error(`Application not installed: ${bundleId}`);
      }
      if (error === 'InstallationLookupFailed' && command === VEND_DOCUMENTS) {
        throw new Error(
          `App '${bundleId}' may not have iTunes File Sharing enabled. Try vendContainer() instead.`,
        );
      }
      if (error) {
        throw new Error(`House Arrest vend failed: ${error}`);
      }
      if (status !== 'Complete') {
        throw new Error(`House Arrest vend failed with status: ${status}`);
      }

      log.debug(`Successfully vended into ${bundleId}`);

      return AfcService.fromSocket(connection.getSocket());
    } catch (error) {
      try {
        connection.close();
      } catch {}
      throw error;
    }
  }

  private getServiceConfig(): { serviceName: string; port: string } {
    return {
      serviceName: HouseArrestService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }
}

export default HouseArrestService;
