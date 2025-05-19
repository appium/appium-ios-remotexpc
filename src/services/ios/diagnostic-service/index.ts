import { logger } from '@appium/support';

import { PlistServiceDecoder } from '../../../lib/plist/plist-decoder.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { BaseService } from '../base-service.js';
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
    timeout?: number;
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

      // Use a longer timeout for IORegistry requests, especially for large responses
      // Default to 3 seconds if not specified
      const timeout = options?.timeout || 3000;

      log.debug('Sending IORegistry request...');

      // Send the request with the specified timeout
      let response = await conn.sendPlistRequest(request, timeout);

      // Enhanced logging for debugging
      log.debug(
        `IORegistry initial response received, size: ${JSON.stringify(response).length} bytes`,
      );

      // If returnRawJson is true, we need to handle the case where the response comes in multiple parts
      if (options?.returnRawJson) {
        // Wait a bit to allow any pending data to be processed
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          const emptyRequest: PlistDictionary = {
            Request: 'Status',
          };

          log.debug(
            'Sending follow-up request to check for additional data...',
          );

          // Send a follow-up request with a shorter timeout
          const additionalResponse = await conn.sendPlistRequest(
            emptyRequest,
            timeout,
          );

          if (additionalResponse) {
            log.debug(
              `Received additional response, size: ${JSON.stringify(additionalResponse).length} bytes`,
            );

            // Check if additionalResponse is a valid object (not Buffer or Date)
            if (
              typeof additionalResponse === 'object' &&
              !Buffer.isBuffer(additionalResponse) &&
              !(additionalResponse instanceof Date)
            ) {
              const hasIORegistry = 'IORegistry' in additionalResponse;
              const hasDiagnostics =
                'Diagnostics' in additionalResponse &&
                typeof additionalResponse.Diagnostics === 'object' &&
                additionalResponse.Diagnostics !== null &&
                'IORegistry' in additionalResponse.Diagnostics;

              if (hasIORegistry || hasDiagnostics) {
                // If the additional response contains IORegistry data, use it instead
                // This is the case where the real data comes in the second response
                log.debug(
                  'Additional response contains IORegistry data, using it as the main response',
                );
                response = additionalResponse;
              } else if (
                typeof response === 'object' &&
                !Buffer.isBuffer(response) &&
                !(response instanceof Date) &&
                Object.keys(additionalResponse).length > 0 &&
                Object.keys(response).length > 0
              ) {
                // Try to merge the responses if both contain useful data
                log.debug('Merging initial and additional responses');
                // Cast both to Record<string, any> to ensure they're treated as objects
                const responseObj = response as Record<string, any>;
                const additionalResponseObj = additionalResponse as Record<
                  string,
                  any
                >;

                response = {
                  ...responseObj,
                  ...additionalResponseObj,
                };
              }
            }
          }
        } catch (error) {
          // If we timeout or get an error, just use the initial response
          log.debug(
            `Error or timeout getting additional data: ${error}, using initial response`,
          );
        }

        // Return the raw response
        return response as Record<string, any>;
      }

      // Check if we have a lastDecodedResult from the PlistServiceDecoder
      if (PlistServiceDecoder.lastDecodedResult) {
        if (Array.isArray(PlistServiceDecoder.lastDecodedResult)) {
          return PlistServiceDecoder.lastDecodedResult as PlistDictionary[];
        }

        // If it's not an array, wrap it in an array
        return [PlistServiceDecoder.lastDecodedResult as PlistDictionary];
      }

      if (!response) {
        throw new Error('Invalid response from IORegistry');
      }

      if (Array.isArray(response)) {
        if (response.length === 0 && typeof response === 'object') {
          log.debug(
            'Received empty array response, attempting to extract useful data',
          );
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

        // Check if the response has the Diagnostics structure
        if (
          responseObj.Diagnostics &&
          typeof responseObj.Diagnostics === 'object'
        ) {
          return [responseObj.Diagnostics as PlistDictionary];
        }

        return [responseObj as PlistDictionary];
      }
      return [{ value: response } as PlistDictionary];
    } catch (error) {
      log.error(`Error querying IORegistry: ${error}`);
      throw error;
    }
  }
}

export default DiagnosticsService;
export { MobileGestaltKeys };
