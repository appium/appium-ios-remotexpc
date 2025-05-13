import { logger } from '@appium/support';

import { PlistServiceDecoder } from '../../../lib/plist/plist-decoder.js';
import type { PlistDictionary } from '../../../lib/types.js';
import BaseService, { type Service } from '../base-service.js';
// Import MobileGestaltKeys directly to avoid module resolution issues
import { MobileGestaltKeys } from './keys.js';

const log = logger.getLogger('DiagnosticService');

/**
 * DiagnosticsService provides an API to:
 * - Query MobileGestalt & IORegistry keys
 * - Reboot, shutdown or put the device in sleep mode
 * - Get WiFi information
 */
class DiagnosticsService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.diagnostics_relay.shim.remote';

  /**
   * Creates a new DiagnosticsService instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    super(address);
  }

  /**
   * Query MobileGestalt keys
   * @param keys Array of keys to query, if not provided all keys will be queried
   * @returns Object containing the queried keys and their values
   */
  async mobileGestalt(keys: string[] = []): Promise<PlistDictionary> {
    try {
      // If no keys provided, use all available keys
      if (!keys || keys.length === 0) {
        keys = MobileGestaltKeys;
      }

      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request: PlistDictionary = {
        Request: 'MobileGestalt',
        MobileGestaltKeys: keys,
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);

      // Ensure we have a valid response
      if (!response || !Array.isArray(response) || response.length === 0) {
        throw new Error('Invalid response from MobileGestalt');
      }
      log.debug(`MobileGestalt response: ${response}`);
      const responseObj = response[0];

      // Check if MobileGestalt is deprecated (iOS >= 17.4)
      if (
        responseObj.Diagnostics?.MobileGestalt?.Status ===
        'MobileGestaltDeprecated'
      ) {
        throw new Error('MobileGestalt deprecated (iOS >= 17.4)');
      }
      log.debug(`MobileGestalt response object: ${responseObj}`);
      // Check for success
      if (
        responseObj.Status !== 'Success' ||
        responseObj.Diagnostics?.MobileGestalt?.Status !== 'Success'
      ) {
        throw new Error('Failed to query MobileGestalt');
      }

      // Create a copy of the result without the Status field
      const result = { ...responseObj.Diagnostics.MobileGestalt };
      delete result.Status;

      return result;
    } catch (error) {
      log.error(`Error querying MobileGestalt: ${error}`);
      throw error;
    }
  }

  /**
   * Restart the device
   * @returns Promise that resolves when the restart request is sent
   */
  async restart(): Promise<PlistDictionary> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request: PlistDictionary = {
        Request: 'Restart',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      log.debug(`Restart response: ${response}`);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
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
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request: PlistDictionary = {
        Request: 'Shutdown',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      log.debug(`Shutdown response: ${response}`);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
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
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request: PlistDictionary = {
        Request: 'Sleep',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      log.debug(`Sleep response: ${response}`);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
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
  }): Promise<PlistDictionary[] | Record<string, any>> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
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

      // Reset the last decoded result
      PlistServiceDecoder.lastDecodedResult = null;

      // Send the request
      const response = await conn.sendPlistRequest(request);

      // Enhanced logging for debugging
      log.debug(`IORegistry response: ${JSON.stringify(response)}`);

      // If user wants raw JSON, return the response directly
      if (options?.returnRawJson) {
        return response as Record<string, any>;
      }

      // Check if we have a lastDecodedResult from the PlistServiceDecoder
      if (PlistServiceDecoder.lastDecodedResult) {
        // Return the lastDecodedResult directly if it's an array
        if (Array.isArray(PlistServiceDecoder.lastDecodedResult)) {
          return PlistServiceDecoder.lastDecodedResult as PlistDictionary[];
        }

        // If it's not an array, wrap it in an array
        return [PlistServiceDecoder.lastDecodedResult as PlistDictionary];
      }

      // Fallback to the original response if lastDecodedResult is not available
      // Ensure we have a valid response
      if (!response) {
        throw new Error('Invalid response from IORegistry');
      }

      // Return the response directly as it appears in the console log
      // This ensures the user gets the same JSON structure they see in the logs
      if (Array.isArray(response)) {
        // If the array is empty, check if there's a response object we can use instead
        if (response.length === 0 && typeof response === 'object') {
          log.debug(
            'Received empty array response, attempting to extract useful data',
          );
          // Try to extract any useful data from the response object itself
          return [{ IORegistryResponse: 'No data found' } as PlistDictionary];
        }
        return response as PlistDictionary[];
      }

      // If it's not an array, convert it to the expected format
      if (
        typeof response === 'object' &&
        !Buffer.isBuffer(response) &&
        !(response instanceof Date)
      ) {
        const responseObj = response as Record<string, any>;

        // Check if the response has the Diagnostics structure
        if (
          responseObj.Diagnostics &&
          typeof responseObj.Diagnostics === 'object'
        ) {
          // Return the Diagnostics object directly
          return [responseObj.Diagnostics as PlistDictionary];
        }

        // Return the whole response object
        return [responseObj as PlistDictionary];
      }

      // If it's not an object, wrap it in an object and return as array
      return [{ value: response } as PlistDictionary];
    } catch (error) {
      log.error(`Error querying IORegistry: ${error}`);
      throw error;
    }
  }
}

export default DiagnosticsService;
export { MobileGestaltKeys };
