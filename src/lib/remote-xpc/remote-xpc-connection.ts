import { logger } from '@appium/support';
import net from 'node:net';

import Handshake from './handshake.js';

const log = logger.getLogger('RemoteXpcConnection');

// Timeout constants
const CONNECTION_TIMEOUT_MS = 30000; // 30 seconds
const SERVICE_EXTRACTION_TIMEOUT_MS = 5000; // 5 seconds
const HANDSHAKE_DELAY_MS = 100; // 100 milliseconds
const SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS = 10000; // 10 seconds
const SOCKET_CLOSE_TIMEOUT_MS = 1000; // 1 second
const SOCKET_END_TIMEOUT_MS = 500; // 0.5 seconds
const SOCKET_WRITE_TIMEOUT_MS = 500; // 0.5 seconds

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
        reject(
          new Error(
            `Connection timed out after ${CONNECTION_TIMEOUT_MS / 1000} seconds`,
          ),
        );
      }, CONNECTION_TIMEOUT_MS);

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
                  }, SERVICE_EXTRACTION_TIMEOUT_MS);
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
              await new Promise<void>((resolve) =>
                setTimeout(resolve, HANDSHAKE_DELAY_MS),
              );

              // Once handshake is successful we can get
              // peer-info and get ports for lockdown in RSD
              await this._handshake.perform();

              // Set a timeout for service extraction
              setTimeout(async () => {
                if (this._services === undefined) {
                  log.warn(
                    'No services received after handshake, closing connection',
                  );
                  try {
                    await this.close();
                  } catch (err) {
                    log.error(`Error closing connection: ${err}`);
                  }
                  reject(new Error('No services received after handshake'));
                }
              }, SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS);
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
    if (!this._socket) {
      return Promise.resolve();
    }

    // Immediately mark as disconnected to prevent further operations
    this._isConnected = false;

    return new Promise<void>((resolve) => {
      // Set a shorter timeout for socket closing
      const closeTimeout = setTimeout(() => {
        log.warn('Socket close timed out, destroying socket');
        this.forceCleanup();
        resolve();
      }, SOCKET_CLOSE_TIMEOUT_MS);

      // Listen for the close event
      if (this._socket) {
        this._socket.once('close', () => {
          log.debug('Socket closed successfully');
          clearTimeout(closeTimeout);
          this.cleanupResources();
          resolve();
        });

        // Add an error handler specifically for the close operation
        this._socket.once('error', (err) => {
          log.error(`Socket error during close: ${err.message}`);
          // Don't wait for timeout, force cleanup immediately
          clearTimeout(closeTimeout);
          this.forceCleanup();
          resolve();
        });
      }

      try {
        // First remove all data listeners to prevent parsing during close
        this.cleanupSocket();

        if (this._socket) {
          // Set a small write timeout to prevent hanging
          this._socket.setTimeout(SOCKET_WRITE_TIMEOUT_MS);

          // End the socket with a small empty buffer to flush any pending data
          this._socket.end(Buffer.alloc(0), () => {
            // If end completes successfully, the 'close' event will handle cleanup
            // But set a short timeout just in case 'close' doesn't fire
            setTimeout(() => {
              if (this._socket) {
                log.debug(
                  'Socket end completed but close event not fired, forcing cleanup',
                );
                clearTimeout(closeTimeout);
                this.forceCleanup();
                resolve();
              }
            }, SOCKET_END_TIMEOUT_MS);
          });
        } else {
          clearTimeout(closeTimeout);
          this.cleanupResources();
          resolve();
        }
      } catch (error) {
        log.error(
          `Unexpected error during close: ${error instanceof Error ? error.message : String(error)}`,
        );
        clearTimeout(closeTimeout);
        this.forceCleanup();
        resolve();
      }
    });
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

  /**
   * Remove all listeners from the socket to prevent memory leaks
   */
  private cleanupSocket(): void {
    if (this._socket) {
      try {
        // Store references to the listeners we want to keep
        const closeListeners = this._socket.listeners('close') as Array<
          (...args: any[]) => void
        >;
        const errorListeners = this._socket.listeners('error') as Array<
          (...args: any[]) => void
        >;

        // Remove all listeners
        this._socket.removeAllListeners();

        // Re-add only the close and error listeners we need for cleanup
        for (const listener of closeListeners) {
          this._socket.once('close', listener);
        }

        for (const listener of errorListeners) {
          this._socket.once('error', listener);
        }

        log.debug('Successfully removed socket data listeners');
      } catch (error) {
        log.error(
          `Error removing socket listeners: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Clean up all resources
   */
  private cleanupResources(): void {
    this._socket = undefined;
    this._isConnected = false;
    this._handshake = undefined;
    this._services = undefined;
  }

  /**
   * Force cleanup by destroying the socket and cleaning up resources
   */
  private forceCleanup(): void {
    try {
      if (this._socket) {
        // Destroy the socket forcefully
        this._socket.destroy();
        log.debug('Socket forcefully destroyed');
      }
    } catch (error) {
      log.error(
        `Error destroying socket: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.cleanupResources();
    }
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

  // Create a mapping of services to ports
  const services: Service[] = [];

  // Assign a port to each service based on proximity in the response
  for (let i = 0; i < serviceMatches.length; i++) {
    const serviceName = serviceMatches[i].value;
    const serviceIndex = serviceMatches[i].index;

    // Find the closest port after this service
    let closestPort = '';
    let closestDistance = Number.MAX_SAFE_INTEGER;

    for (const portMatch of portMatches) {
      // Only consider ports that come after the service in the response
      if (portMatch.index > serviceIndex) {
        const distance = portMatch.index - serviceIndex;

        // If this port is closer than the current closest, update
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPort = portMatch.value;

          // If the port is very close (within 200 chars), we can be confident it's the right one
          if (distance < 200) {
            break;
          }
        }
      }
    }

    // Add the service with its port (or empty string if no port found)
    services.push({
      serviceName,
      port: closestPort || '',
    });
  }

  return { services };
}

export { RemoteXpcConnection, type Service, type ServicesResponse };
