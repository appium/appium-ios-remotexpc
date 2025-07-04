import { logger } from '@appium/support';

import { PlistServiceDecoder } from '../../../lib/plist/plist-decoder.js';
import type {
  DiagnosticsService as DiagnosticsServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('DiagnosticService');

/**
 * DiagnosticsService provides an API to:
 * - Query MobileGestalt & IORegistry keys
 * - Reboot, shutdown or put the device in sleep mode
 * - Get WiFi information
 */
class DiagnosticsService
  extends BaseService
  implements DiagnosticsServiceInterface
{
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.diagnostics_relay.shim.remote';

  constructor(address: [string, number]) {
    super(address);
  }

  /**
   * Restart the device
   * @returns Promise that resolves when the restart request is sent
   */
  async restart(): Promise<PlistDictionary> {
    try {
      const request: PlistDictionary = {
        Request: 'Restart',
      };

      return await this.sendRequest(request);
    } catch (error) {
      log.error(`Error restarting device: ${error}`);
      throw error;
    }
  }

  /**
   * Shutdown the device
   * @returns Promise that resolves when the shutdown request is sent
   */
  async shutdown(): Promise<PlistDictionary> {
    try {
      const request: PlistDictionary = {
        Request: 'Shutdown',
      };

      return await this.sendRequest(request);
    } catch (error) {
      log.error(`Error shutting down device: ${error}`);
      throw error;
    }
  }

  /**
   * Put the device in sleep mode
   * @returns Promise that resolves when the sleep request is sent
   */
  async sleep(): Promise<PlistDictionary> {
    try {
      const request: PlistDictionary = {
        Request: 'Sleep',
      };

      return await this.sendRequest(request);
    } catch (error) {
      log.error(`Error putting device to sleep: ${error}`);
      throw error;
    }
  }

  /**
   * Query IORegistry
   * @returns Object containing the IORegistry information
   * @param options
   */
  async ioregistry(options?: {
    plane?: string;
    name?: string;
    ioClass?: string;
    returnRawJson?: boolean;
    timeout?: number;
  }): Promise<PlistDictionary[] | Record<string, any>> {
    try {
      const request: PlistDictionary = {
        Request: 'IORegistry',
      };

      if (options?.plane) {
        request.CurrentPlane = options.plane;
      }
      if (options?.name) {
        request.EntryName = options.name;
      }
      if (options?.ioClass) {
        request.EntryClass = options.ioClass;
      }

      PlistServiceDecoder.lastDecodedResult = null;

      const timeout = options?.timeout || 3000;

      log.debug('Sending IORegistry request...');

      const conn = await this.connectToDiagnosticService();
      const response = await conn.sendPlistRequest(request, timeout);

      log.debug(
        `IORegistry response size: ${JSON.stringify(response).length} bytes`,
      );

      if (options?.returnRawJson) {
        return await this.handleMultipartIORegistryResponse(
          conn,
          response,
          timeout,
        );
      }

      return this.processIORegistryResponse(response);
    } catch (error) {
      log.error(`Error querying IORegistry: ${error}`);
      throw error;
    }
  }

  private getServiceConfig() {
    return {
      serviceName: DiagnosticsService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }

  private async connectToDiagnosticService() {
    const service = this.getServiceConfig();
    return await this.startLockdownService(service);
  }

  private async sendRequest(
    request: PlistDictionary,
    timeout?: number,
  ): Promise<PlistDictionary> {
    const conn = await this.connectToDiagnosticService();
    const response = await conn.sendPlistRequest(request, timeout);

    log.debug(`${request.Request} response received`);

    if (!response) {
      return {};
    }

    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }

    return response as PlistDictionary;
  }

  private processIORegistryResponse(
    response: any,
  ): PlistDictionary[] | Record<string, any> {
    if (PlistServiceDecoder.lastDecodedResult) {
      if (Array.isArray(PlistServiceDecoder.lastDecodedResult)) {
        return PlistServiceDecoder.lastDecodedResult as PlistDictionary[];
      }
      return [PlistServiceDecoder.lastDecodedResult as PlistDictionary];
    }

    if (!response) {
      throw new Error('Invalid response from IORegistry');
    }

    if (Array.isArray(response)) {
      if (response.length === 0 && typeof response === 'object') {
        log.debug('Received empty array response');
        return [{ IORegistryResponse: 'No data found' } as PlistDictionary];
      }
      return response as PlistDictionary[];
    }

    if (
      typeof response === 'object' &&
      !Buffer.isBuffer(response) &&
      !(response instanceof Date)
    ) {
      const responseObj = response as Record<string, any>;

      if (
        responseObj.Diagnostics &&
        typeof responseObj.Diagnostics === 'object'
      ) {
        return [responseObj.Diagnostics as PlistDictionary];
      }

      return [responseObj as PlistDictionary];
    }

    return [{ value: response } as PlistDictionary];
  }

  private async handleMultipartIORegistryResponse(
    conn: any,
    initialResponse: any,
    timeout: number,
  ): Promise<Record<string, any>> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const emptyRequest: PlistDictionary = {
      Request: 'Status',
    };

    log.debug('Sending follow-up request for additional data');

    const additionalResponse = await conn.sendPlistRequest(
      emptyRequest,
      timeout,
    );
    const hasDiagnostics =
      'Diagnostics' in additionalResponse &&
      typeof additionalResponse.Diagnostics === 'object' &&
      additionalResponse.Diagnostics !== null &&
      'IORegistry' in additionalResponse.Diagnostics;
    if (additionalResponse.Status !== 'Success' && hasDiagnostics) {
      throw new Error(`Error getting diagnostic data: ${additionalResponse}`);
    }

    log.debug('Using additional response with IORegistry data');
    return additionalResponse.Diagnostics.IORegistry as Record<string, any>;
  }
}

export default DiagnosticsService;
