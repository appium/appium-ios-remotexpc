import { getLogger } from '../../../lib/logger.js';
import { PlistServiceDecoder } from '../../../lib/plist/plist-decoder.js';
import type {
  DiagnosticsService as DiagnosticsServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import type { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = getLogger('DiagnosticService');

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
      const response = await this.queryIORegistry(conn, request, timeout);

      if (options?.returnRawJson) {
        // The query matched no entry when the device replies with a bare
        // { Status: 'Success' } and no Diagnostics — surface an empty object.
        return this.extractIORegistry(response) ?? {};
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

  private async connectToDiagnosticService(): Promise<ServiceConnection> {
    const connection = await this.startLockdownService(this.getServiceConfig());
    const startServiceResponse = await connection.receive();
    if (startServiceResponse?.Request !== 'StartService') {
      throw new Error(
        `Expected StartService response, got: ${JSON.stringify(startServiceResponse)}`,
      );
    }
    return connection;
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

  /**
   * Sends an IORegistry request and returns the diagnostics response.
   * The shim's StartService greeting is drained in connectToDiagnosticService,
   * so this is a plain single send/recv — matches pymobiledevice3.
   */
  private async queryIORegistry(
    conn: ServiceConnection,
    request: PlistDictionary,
    timeout: number,
  ): Promise<PlistDictionary> {
    const response = await conn.sendPlistRequest(request, timeout);

    if (
      response &&
      typeof response === 'object' &&
      'Status' in response &&
      response.Status !== 'Success'
    ) {
      throw new Error(`IORegistry query failed: ${JSON.stringify(response)}`);
    }

    return response as PlistDictionary;
  }

  /**
   * Extracts the IORegistry payload from a diagnostics response.
   * @returns the IORegistry object, or null when the query matched no entry
   * (the device replies { Status: 'Success' } with no Diagnostics)
   */
  private extractIORegistry(response: any): Record<string, any> | null {
    const diagnostics = response?.Diagnostics;
    if (diagnostics && typeof diagnostics === 'object') {
      const ioRegistry = diagnostics.IORegistry;
      if (ioRegistry && typeof ioRegistry === 'object') {
        return ioRegistry as Record<string, any>;
      }
    }
    return null;
  }
}

export default DiagnosticsService;
