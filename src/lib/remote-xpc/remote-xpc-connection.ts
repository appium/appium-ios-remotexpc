import net from 'node:net';

import { getLogger } from '../logger.js';
import Handshake from './handshake.js';

const log = getLogger('RemoteXpcConnection');

// Timeout constants
/** Max time to wait for the TCP socket to connect. */
export const CONNECTION_CONNECT_TIMEOUT_MS = 500;
const HANDSHAKE_DELAY_MS = 100;
/** Wait for service list after handshake before failing the connect attempt. */
const SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Resolve with partial data if service parsing stalls mid-stream. */
const SERVICE_EXTRACTION_TIMEOUT_MS = 5_000;
/**
 * Default max time for one connect attempt (TCP + handshake + service discovery).
 * Must cover the longest connect-phase timeout plus earlier phases.
 */
export const CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS = Math.max(
  SERVICE_EXTRACTION_TIMEOUT_MS,
  SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS +
    HANDSHAKE_DELAY_MS +
    CONNECTION_CONNECT_TIMEOUT_MS,
);
/** TunnelManager retry budget; never shorter than a single connect attempt. */
export const CONNECTION_OVERALL_TIMEOUT_MS =
  CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS;
const SOCKET_CLOSE_TIMEOUT_MS = 1000; // 1 second
const SOCKET_END_TIMEOUT_MS = 500; // 0.5 seconds
const SOCKET_WRITE_TIMEOUT_MS = 500; // 0.5 seconds

export interface RemoteXpcConnectOptions {
  /** Max time for this connect attempt (TCP + handshake + services). */
  timeoutMs?: number;
}

interface Service {
  serviceName: string;
  port: string;
}

interface ServicesResponse {
  services: Service[];
}

/** Guards connect() resolve/reject and clears active connect-phase timers. */
interface ConnectSession {
  settleSuccess(response: ServicesResponse): void;
  settleFailure(error: Error | unknown): void;
  isSettled(): boolean;
  clearTcpTimer(): void;
  trackPartialExtractionTimer(timer: NodeJS.Timeout): void;
}

class RemoteXpcConnection {
  private readonly _address: [string, number];
  private _socket: net.Socket | undefined;
  private _handshake: Handshake | undefined;
  private _isConnected: boolean;
  private _services: Service[] | undefined;
  /** Timer set during connect() to detect missing services after handshake */
  private _serviceExtractionTimer: NodeJS.Timeout | undefined;
  /** True while close() is intentionally tearing down the socket. */
  private _isClosing: boolean;

  constructor(address: [string, number]) {
    this._address = address;
    this._socket = undefined;
    this._handshake = undefined;
    this._isConnected = false;
    this._services = undefined;
    this._serviceExtractionTimer = undefined;
    this._isClosing = false;
  }

  /**
   * Tunnel endpoint `[host, port]` (RSD) this connection targets.
   * Use the host when opening follow-on TCP services on the same tunnel interface.
   */
  get address(): [string, number] {
    return this._address;
  }

  /**
   * Connect to the remote device and perform handshake
   * @returns Promise that resolves with the list of available services
   */
  async connect(options?: RemoteXpcConnectOptions): Promise<ServicesResponse> {
    if (this._isConnected) {
      throw new Error('Already connected');
    }

    const operationTimeoutMs =
      options?.timeoutMs ?? CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS;

    return new Promise<ServicesResponse>((resolve, reject) => {
      const session = this.createConnectSession(
        operationTimeoutMs,
        resolve,
        reject,
      );

      try {
        this._socket = this.createConnectSocket();
        this.registerConnectSocketHandlers(session, this._socket);
      } catch (error) {
        log.error(`Failed to create connection: ${error}`);
        session.settleFailure(error);
      }
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    this._isClosing = true;
    this.clearServiceExtractionTimer();

    const socket = this._socket;
    if (!socket) {
      return;
    }

    this._isConnected = false;
    await this.shutdownSocket(socket);
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

  private createConnectSession(
    operationTimeoutMs: number,
    resolve: (response: ServicesResponse) => void,
    reject: (reason: Error) => void,
  ): ConnectSession {
    let settled = false;
    let partialExtractionTimer: NodeJS.Timeout | undefined;

    const clearAllTimers = (): void => {
      clearTimeout(operationTimer);
      clearTimeout(tcpTimer);
      if (partialExtractionTimer) {
        clearTimeout(partialExtractionTimer);
        partialExtractionTimer = undefined;
      }
    };

    const settleSuccess = (response: ServicesResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      this._services = response.services;
      resolve(response);
    };

    const settleFailure = (error: Error | unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const operationTimer = setTimeout(() => {
      this._socket?.destroy();
      settleFailure(
        new Error(`Connection timed out after ${operationTimeoutMs}ms`),
      );
    }, operationTimeoutMs);

    const tcpTimer = setTimeout(() => {
      this._socket?.destroy();
      settleFailure(
        new Error(
          `Connection timed out after ${CONNECTION_CONNECT_TIMEOUT_MS}ms`,
        ),
      );
    }, CONNECTION_CONNECT_TIMEOUT_MS);

    return {
      settleSuccess,
      settleFailure,
      isSettled: () => settled,
      clearTcpTimer: () => clearTimeout(tcpTimer),
      trackPartialExtractionTimer: (timer) => {
        partialExtractionTimer = timer;
      },
    };
  }

  private createConnectSocket(): net.Socket {
    return net.connect({
      host: this._address[0],
      port: this._address[1],
      family: 6,
      noDelay: true,
      keepAlive: true,
    });
  }

  private registerConnectSocketHandlers(
    session: ConnectSession,
    socket: net.Socket,
  ): void {
    let accumulatedData = Buffer.alloc(0);
    let partialExtractionTimer: NodeJS.Timeout | undefined;

    const schedulePartialExtractionTimeout = (): void => {
      if (partialExtractionTimer) {
        return;
      }

      partialExtractionTimer = setTimeout(() => {
        partialExtractionTimer = undefined;
        log.warn(
          'Service extraction timeout reached, resolving with current data',
        );
        const finalResponse = extractServices(accumulatedData.toString('utf8'));
        session.settleSuccess(finalResponse);
      }, SERVICE_EXTRACTION_TIMEOUT_MS);
      session.trackPartialExtractionTimer(partialExtractionTimer);
    };

    socket.once('error', (error: Error) => {
      if (!this._isClosing) {
        log.error(`Connection error: ${error}`);
      }
      this._isConnected = false;
      session.settleFailure(error);
    });

    socket.on('data', (data: Buffer | string) => {
      if (Buffer.isBuffer(data) || typeof data === 'string') {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
        accumulatedData = Buffer.concat([accumulatedData, chunk]);
      }

      this.tryResolveServicesFromPayload(
        session,
        accumulatedData,
        schedulePartialExtractionTimeout,
      );
    });

    socket.once('close', () => {
      this._isConnected = false;

      if (!session.isSettled()) {
        session.settleFailure(
          new Error('Connection closed before services were extracted'),
        );
      }
    });

    socket.once('connect', () => {
      session.clearTcpTimer();
      void this.onConnectSocketReady(session, socket);
    });
  }

  private tryResolveServicesFromPayload(
    session: ConnectSession,
    accumulatedData: Buffer,
    schedulePartialExtractionTimeout: () => void,
  ): void {
    const dataStr = accumulatedData.toString('utf8');
    if (!dataStr.includes('com.apple') || !dataStr.includes('Port')) {
      return;
    }

    try {
      const servicesResponse = extractServices(dataStr);
      if (servicesResponse.services.length > 0) {
        session.settleSuccess(servicesResponse);
        return;
      }

      schedulePartialExtractionTimeout();
    } catch (error) {
      log.warn(
        `Error extracting services: ${error}, continuing to collect data`,
      );
    }
  }

  private async onConnectSocketReady(
    session: ConnectSession,
    socket: net.Socket,
  ): Promise<void> {
    this._isConnected = true;

    try {
      await this.performHandshake(socket);
      this.schedulePostHandshakeServiceTimeout(session);
    } catch (error) {
      log.error(`Handshake failed: ${error}`);
      session.settleFailure(error);
      await this.close();
    }
  }

  private async performHandshake(socket: net.Socket): Promise<void> {
    this._handshake = new Handshake(socket);

    await new Promise<void>((resolve) =>
      setTimeout(resolve, HANDSHAKE_DELAY_MS),
    );

    await this._handshake.perform();
  }

  private schedulePostHandshakeServiceTimeout(session: ConnectSession): void {
    this.clearServiceExtractionTimer();

    this._serviceExtractionTimer = setTimeout(() => {
      void this.handlePostHandshakeServiceTimeout(session);
    }, SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS);
  }

  private async handlePostHandshakeServiceTimeout(
    session: ConnectSession,
  ): Promise<void> {
    this._serviceExtractionTimer = undefined;

    if (this._services !== undefined || session.isSettled()) {
      return;
    }

    log.warn('No services received after handshake, closing connection');
    try {
      await this.close();
    } catch (err) {
      log.error(`Error closing connection: ${err}`);
    }
    session.settleFailure(new Error('No services received after handshake'));
  }

  private clearServiceExtractionTimer(): void {
    if (!this._serviceExtractionTimer) {
      return;
    }

    clearTimeout(this._serviceExtractionTimer);
    this._serviceExtractionTimer = undefined;
  }

  private shutdownSocket(socket: net.Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const closeTimeout = setTimeout(() => {
        log.warn('Socket close timed out, destroying socket');
        this.forceCleanup();
        finish();
      }, SOCKET_CLOSE_TIMEOUT_MS);

      const onClosed = (): void => {
        clearTimeout(closeTimeout);
        this.cleanupResources();
        finish();
      };

      socket.once('close', onClosed);
      socket.on('error', () => {});

      try {
        this.cleanupSocket();
        socket.setTimeout(SOCKET_WRITE_TIMEOUT_MS);
        socket.end(Buffer.alloc(0), () => {
          setTimeout(() => {
            if (!finished && this._socket) {
              clearTimeout(closeTimeout);
              this.forceCleanup();
              finish();
            }
          }, SOCKET_END_TIMEOUT_MS);
        });
      } catch (error) {
        log.error(
          `Unexpected error during close: ${error instanceof Error ? error.message : String(error)}`,
        );
        clearTimeout(closeTimeout);
        this.forceCleanup();
        finish();
      }
    });
  }

  /**
   * Remove data listeners used by the service-discovery phase.
   *
   * We intentionally keep close/error listeners registered by close() so that
   * transport teardown events (for example ECONNRESET) are handled gracefully.
   */
  private cleanupSocket(): void {
    if (this._socket) {
      try {
        // Stop the service-discovery parser from processing additional frames
        // while shutdown is in progress.
        this._socket.removeAllListeners('data');
      } catch (error) {
        log.error(
          `Error removing socket data listeners: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Clean up all resources
   */
  private cleanupResources(): void {
    if (this._serviceExtractionTimer) {
      clearTimeout(this._serviceExtractionTimer);
      this._serviceExtractionTimer = undefined;
    }
    this._socket = undefined;
    this._isConnected = false;
    this._isClosing = false;
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
