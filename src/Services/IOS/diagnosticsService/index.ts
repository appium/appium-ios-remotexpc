import ServiceConnection from '../../../ServiceConnection.js';
// Import MobileGestaltKeys directly to avoid module resolution issues
import { MobileGestaltKeys } from './keys.js';

interface Service {
  serviceName: string;
  port: string;
}

/**
 * DiagnosticsService provides an API to:
 * - Query MobileGestalt & IORegistry keys
 * - Reboot, shutdown or put the device in sleep mode
 */
class DiagnosticsService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.diagnostics_relay.shim.remote';

  private address: [string, number]; // [host, port]

  /**
   * Creates a new DiagnosticsService instance
   * @param address Tuple containing [host, port]
   */
  constructor(address: [string, number]) {
    this.address = address;
  }

  /**
   * Query MobileGestalt keys
   * @param keys Array of keys to query, if not provided all keys will be queried
   * @returns Object containing the queried keys and their values
   */
  async mobileGestalt(keys: string[] = []): Promise<Record<string, any>> {
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
      const request = {
        Request: 'MobileGestalt',
        MobileGestaltKeys: keys,
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);

      // Ensure we have a valid response
      if (!response || !Array.isArray(response) || response.length === 0) {
        throw new Error('Invalid response from MobileGestalt');
      }
      console.log('response', response);
      const responseObj = response[0];

      // Check if MobileGestalt is deprecated (iOS >= 17.4)
      if (
        responseObj.Diagnostics?.MobileGestalt?.Status ===
        'MobileGestaltDeprecated'
      ) {
        throw new Error('MobileGestalt deprecated (iOS >= 17.4)');
      }
      console.log('responseObj', responseObj);
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
      console.error('Error querying MobileGestalt:', error);
      throw error;
    }
  }

  /**
   * Restart the device
   * @returns Promise that resolves when the restart request is sent
   */
  async restart(): Promise<Record<string, any>> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request = {
        Request: 'Restart',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      console.log('Restart response:', response);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
    } catch (error) {
      console.error('Error restarting device:', error);
      throw error;
    }
  }

  /**
   * Shutdown the device
   * @returns Promise that resolves when the shutdown request is sent
   */
  async shutdown(): Promise<Record<string, any>> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request = {
        Request: 'Shutdown',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      console.log('Shutdown response:', response);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
    } catch (error) {
      console.error('Error shutting down device:', error);
      throw error;
    }
  }

  /**
   * Put the device in sleep mode
   * @returns Promise that resolves when the sleep request is sent
   */
  async sleep(): Promise<Record<string, any>> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request = {
        Request: 'Sleep',
      };

      // Send the request
      const response = await conn.sendPlistRequest(request);
      console.log('Sleep response:', response);

      // Ensure we return a non-null object
      if (!response || !Array.isArray(response) || response.length === 0) {
        return {};
      }

      return response[0] || {};
    } catch (error) {
      console.error('Error putting device to sleep:', error);
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
  }): Promise<Record<string, any>> {
    try {
      // Create a connection to the diagnostics service
      const service = {
        serviceName: DiagnosticsService.RSD_SERVICE_NAME,
        port: this.address[1].toString(),
      };

      // Connect to the diagnostics service
      const conn = await this.startLockdownService(service);

      // Create the request
      const request: Record<string, any> = {
        Request: 'IORegistry',
      };

      if (options?.plane) request.CurrentPlane = options.plane;
      if (options?.name) request.EntryName = options.name;
      if (options?.ioClass) request.EntryClass = options.ioClass;

      // Send the request
      const response = await conn.sendPlistRequest(request);
      console.log('IORegistry response:', response);
      // Ensure we have a valid response
      if (!response || !Array.isArray(response) || response.length === 0) {
        throw new Error('Invalid response from IORegistry');
      }

      return response || {};
    } catch (error) {
      console.error('Error querying IORegistry:', error);
      throw error;
    }
  }

  /**
   * Starts a lockdown service without sending a check-in message
   * @returns Promise resolving to a ServiceConnection
   * @param service
   */
  private async startLockdownWithoutCheckin(
    service: Service,
  ): Promise<ServiceConnection> {
    // Get the port for the requested service
    const port = service.port;
    return ServiceConnection.createUsingTCP(this.address[0], port);
  }

  /**
   * Starts a lockdown service with proper check-in
   * @returns Promise resolving to a ServiceConnection
   * @param service
   */
  private async startLockdownService(
    service: Service,
  ): Promise<ServiceConnection> {
    const connection = await this.startLockdownWithoutCheckin(service);
    const checkin = {
      Label: 'appium-internal',
      ProtocolVersion: '2',
      Request: 'RSDCheckin',
    };

    const response = await connection.sendPlistRequest(checkin);
    console.log('Service check-in response:', response);
    return connection;
  }
}

export default DiagnosticsService;
export { MobileGestaltKeys };
