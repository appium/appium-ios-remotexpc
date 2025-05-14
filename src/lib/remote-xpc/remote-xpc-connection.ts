import { logger } from '@appium/support';
import net from 'node:net';

import Handshake from './handshake.js';

const log = logger.getLogger('RemoteXpcConnection');

interface Service {
  serviceName: string;
  port: string;
}

interface ServicesResponse {
  services: Service[];
}

type ConnectionTimeout = NodeJS.Timeout;
type ServiceExtractionTimeout = NodeJS.Timeout;

class RemoteXpcConnection {
  private readonly _address: [string, number];
  private _socket: net.Socket | undefined;
  private _handshake: Handshake | undefined;
  private _isConnected: boolean;
  private _services: Service[] | undefined;

  constructor(address: [string, number]) {
    this._address = address;
    this._socket = undefined;
    this._handshake = undefined;
    this._isConnected = false;
    this._services = undefined;
  }

  /**
   * Connect to the remote device and perform handshake
   * @returns Promise that resolves with the list of available services
   */
  async connect(): Promise<ServicesResponse> {
    if (this._isConnected) {
      throw new Error('Already connected');
    }

    return new Promise<ServicesResponse>((resolve, reject) => {
      // Set a timeout for the entire connection process
      const connectionTimeout: ConnectionTimeout = setTimeout(() => {
        if (this._socket) {
          this._socket.destroy();
        }
        reject(new Error('Connection timed out after 30 seconds'));
      }, 30000);

      // Set a timeout for service extraction
      let serviceExtractionTimeout: ServiceExtractionTimeout;

      const clearTimeouts = (): void => {
        clearTimeout(connectionTimeout);
        if (serviceExtractionTimeout) {
          clearTimeout(serviceExtractionTimeout);
        }
      };

      try {
        this._socket = net.connect({
          host: this._address[0],
          port: this._address[1],
          family: 6,
        });

        this._socket.setNoDelay(true);
        this._socket.setKeepAlive(true);

        // Buffer to accumulate data
        let accumulatedData = Buffer.alloc(0);

        this._socket.once('error', (error: Error) => {
          log.error(`Connection error: ${error}`);
          this._isConnected = false;
          clearTimeouts();
          reject(error);
        });

        // Handle incoming data
        this._socket.on('data', (data: Buffer | string) => {
          if (Buffer.isBuffer(data) || typeof data === 'string') {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Buffer.from(data, 'hex');

            // Accumulate data
            accumulatedData = Buffer.concat([accumulatedData, buffer]);

            // Check if we have enough data to extract services
            // Don't rely solely on buffer length, also check for service patterns
            const dataStr = accumulatedData.toString('utf8');
            if (dataStr.includes('com.apple') && dataStr.includes('Port')) {
              try {
                const servicesResponse = extractServices(dataStr);

                // Only resolve if we found at least one service
                if (servicesResponse.services.length > 0) {
                  this._services = servicesResponse.services;
                  log.info(
                    `Extracted ${servicesResponse.services.length} services`,
                  );
                  clearTimeouts();
                  resolve(servicesResponse);
                } else if (!serviceExtractionTimeout) {
                  // Set a timeout to resolve with whatever we have if no more data comes
                  serviceExtractionTimeout = setTimeout(() => {
                    log.warn(
                      'Service extraction timeout reached, resolving with current data',
                    );
                    const finalResponse = extractServices(
                      accumulatedData.toString('utf8'),
                    );
                    this._services = finalResponse.services;
                    clearTimeouts();
                    resolve(finalResponse);
                  }, 5000);
                }
              } catch (error) {
                log.warn(
                  `Error extracting services: ${error}, continuing to collect data`,
                );
              }
            }
          }
        });

        this._socket.on('close', () => {
          log.info('Socket closed');
          this._isConnected = false;
          clearTimeouts();

          // If we haven't resolved yet, reject with an error
          if (this._services === undefined) {
            reject(
              new Error('Connection closed before services were extracted'),
            );
          }
        });

        this._socket.once('connect', async () => {
          try {
            this._isConnected = true;
            if (this._socket) {
              this._handshake = new Handshake(this._socket);

              // Add a small delay before performing handshake to ensure socket is ready
              await new Promise<void>((resolve) => setTimeout(resolve, 100));

              // Once handshake is successful we can get
              // peer-info and get ports for lockdown in RSD
              await this._handshake.perform();

              // Set a timeout for service extraction
              setTimeout(() => {
                if (this._services === undefined) {
                  log.warn(
                    'No services received after handshake, closing connection',
                  );
                  this.close().catch((err: Error) =>
                    log.error(`Error closing connection: ${err}`),
                  );
                  reject(new Error('No services received after handshake'));
                }
              }, 10000);
            }
          } catch (error) {
            log.error(`Handshake failed: ${error}`);
            clearTimeouts();
            await this.close();
            reject(error);
          }
        });
      } catch (error) {
        log.error(`Failed to create connection: ${error}`);
        clearTimeouts();
        reject(error);
      }
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this._socket) {
      return new Promise<void>((resolve, reject) => {
        // Set a timeout for socket closing
        const closeTimeout = setTimeout(() => {
          log.warn('Socket close timed out, destroying socket');
          if (this._socket) {
            this._socket.destroy();
          }

          // Clean up resources
          this._socket = undefined;
          this._isConnected = false;
          this._handshake = undefined;
          this._services = undefined;

          resolve();
        }, 5000);

        // Remove all listeners to prevent memory leaks
        const removeAllListeners = (): void => {
          if (this._socket) {
            this._socket.removeAllListeners('data');
            this._socket.removeAllListeners('error');
            this._socket.removeAllListeners('close');
            this._socket.removeAllListeners('connect');
          }
        };

        // Listen for the close event
        if (this._socket) {
          this._socket.once('close', () => {
            clearTimeout(closeTimeout);
            resolve();
          });
        }

        try {
          if (this._socket) {
            // First try to end the socket gracefully
            this._socket.end((err?: Error) => {
              if (err) {
                log.error(`Error closing socket: ${err}`);
                clearTimeout(closeTimeout);

                // Try to destroy the socket as a fallback
                if (this._socket) {
                  try {
                    this._socket.destroy();
                  } catch (destroyErr) {
                    log.error(`Error destroying socket: ${destroyErr}`);
                  }
                }

                removeAllListeners();

                // Clean up resources
                this._socket = undefined;
                this._isConnected = false;
                this._handshake = undefined;
                this._services = undefined;

                reject(err);
              }
            });
          } else {
            clearTimeout(closeTimeout);
            resolve();
          }
        } catch (error) {
          log.error(`Unexpected error during close: ${error}`);
          clearTimeout(closeTimeout);
          removeAllListeners();

          // Clean up resources
          this._socket = undefined;
          this._isConnected = false;
          this._handshake = undefined;
          this._services = undefined;

          reject(error);
        }
      });
    }
    return Promise.resolve();
  }

  /**
   * Get the list of available services
   * @returns Array of available services
   */
  getServices(): Service[] {
    if (!this._services) {
      throw new Error('Not connected or services not available');
    }
    return this._services;
  }

  /**
   * List all available services
   * @returns Array of all available services
   */
  listAllServices(): Service[] {
    return this.getServices();
  }

  /**
   * Find a service by name
   * @param serviceName The name of the service to find
   * @returns The service or throws an error if not found
   */
  findService(serviceName: string): Service {
    const services = this.getServices();
    const service = services.find(
      (service) => service.serviceName === serviceName,
    );
    if (!service) {
      throw new Error(`Service ${serviceName} not found, 
        Check if the device is locked.`);
    }
    return service;
  }
}

/**
 * Extract services from the response
 * @param response The response string to parse
 * @returns Object containing the extracted services
 */
function extractServices(response: string): ServicesResponse {
  // More robust regex that handles various formats of service names and port specifications
  const serviceRegex = /com\.apple(?:\.[\w-]+)+/g;
  const portRegex = /Port[^0-9]*(\d+)/g;

  interface Match {
    value: string;
    index: number;
  }

  interface Item extends Match {
    type: 'service' | 'port';
  }

  // First, collect all service names
  const serviceMatches: Match[] = [];
  let match: RegExpExecArray | null;
  while ((match = serviceRegex.exec(response)) !== null) {
    serviceMatches.push({ value: match[0], index: match.index });
  }

  // Then, collect all port numbers
  const portMatches: Match[] = [];
  while ((match = portRegex.exec(response)) !== null) {
    if (match[1]) {
      // Ensure we have a captured port number
      portMatches.push({ value: match[1], index: match.index });
    }
  }

  // Sort both arrays by index to maintain order
  serviceMatches.sort((a, b) => a.index - b.index);
  portMatches.sort((a, b) => a.index - b.index);

  // Log the extracted data for debugging
  log.debug(
    `Found ${serviceMatches.length} services and ${portMatches.length} ports`,
  );

  type ItemType = { type: 'service' | 'port'; value: string; index: number };

  // Create a combined array of items
  const items: ItemType[] = [
    ...serviceMatches.map((m) => ({
      type: 'service' as const,
      value: m.value,
      index: m.index,
    })),
    ...portMatches.map((m) => ({
      type: 'port' as const,
      value: m.value,
      index: m.index,
    })),
  ].sort((a, b) => a.index - b.index);

  // Process the items to create service objects
  const services: Service[] = [];
  const processedServices = new Set<string>(); // Track processed services to avoid duplicates

  for (let i = 0; i < items.length; i++) {
    if (items[i].type === 'service') {
      const serviceName = items[i].value;

      // Skip if we've already processed this service
      if (processedServices.has(serviceName)) {
        continue;
      }

      // Look ahead for the next port occurrence
      let port: string | undefined;
      let portIndex = -1;

      for (let j = i + 1; j < items.length; j++) {
        if (items[j].type === 'port') {
          port = items[j].value;
          portIndex = j;
          break;
        }
      }

      // If no port is found, check if there are any ports available
      if (!port && portMatches.length > 0) {
        // As a fallback, use the nearest port by index
        let nearestPort = portMatches[0];
        let minDistance = Math.abs(nearestPort.index - items[i].index);

        for (const portMatch of portMatches) {
          const distance = Math.abs(portMatch.index - items[i].index);
          if (distance < minDistance) {
            minDistance = distance;
            nearestPort = portMatch;
          }
        }

        // Only use the nearest port if it's reasonably close (within 500 characters)
        if (minDistance < 500) {
          port = nearestPort.value;
        }
      }

      // Add the service with its port (or empty string if no port found)
      services.push({ serviceName, port: port || '' });
      processedServices.add(serviceName);

      // If we found a port, skip all items up to and including that port
      if (portIndex > i) {
        i = portIndex;
      }
    }
  }

  return { services };
}

export default RemoteXpcConnection;
export { type Service, type ServicesResponse };
