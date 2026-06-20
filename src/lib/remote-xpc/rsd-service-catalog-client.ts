import { getLogger } from '../logger.js';
import { RemoteXpcFramedTransport } from './remote-xpc-framed-transport.js';
import {
  type Service,
  type ServicesResponse,
  servicesFromXpcBody,
} from './service-catalog.js';

const log = getLogger('RsdServiceCatalogClient');

// Timeout constants
/** Max time to wait for the TCP socket to connect. */
export const CONNECTION_CONNECT_TIMEOUT_MS = 3_000;
const HANDSHAKE_DELAY_MS = 100;
/** Wait for service list after handshake before failing the connect attempt. */
const SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Default max time for one connect attempt (TCP + handshake + service discovery).
 * Sum of connect, handshake delay, and post-handshake service wait.
 */
export const CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS =
  SERVICE_AFTER_HANDSHAKE_TIMEOUT_MS +
  HANDSHAKE_DELAY_MS +
  CONNECTION_CONNECT_TIMEOUT_MS;
/** TunnelManager retry budget; never shorter than a single connect attempt. */
export const CONNECTION_OVERALL_TIMEOUT_MS =
  CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS;

export interface RsdServiceCatalogClientConnectOptions {
  /** Max time for this connect attempt (TCP + handshake + services). */
  timeoutMs?: number;
}

/** Guards connect() resolve/reject and clears active connect-phase timers. */
interface ConnectSession {
  settleSuccess(response: ServicesResponse): void;
  settleFailure(error: Error | unknown): void;
  isSettled(): boolean;
}

class RsdServiceCatalogClient {
  private readonly _address: [string, number];
  private _transport: RemoteXpcFramedTransport | undefined;
  private _isConnected: boolean;
  private _services: Service[] | undefined;
  /** Timer set during connect() to detect missing services after handshake */
  private _serviceExtractionTimer: NodeJS.Timeout | undefined;
  /** True while close() is intentionally tearing down the socket. */
  private _isClosing: boolean;

  constructor(address: [string, number]) {
    this._address = address;
    this._transport = undefined;
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
   * Connect to Remote Service Discovery and return the advertised services.
   */
  async connect(
    options?: RsdServiceCatalogClientConnectOptions,
  ): Promise<ServicesResponse> {
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
        const transport = new RemoteXpcFramedTransport(this._address);
        this._transport = transport;
        this.registerTransportHandlers(session, transport);
        void this.connectTransport(session, transport, operationTimeoutMs);
      } catch (error) {
        log.error(`Failed to create RSD catalog client: ${error}`);
        session.settleFailure(error);
      }
    });
  }

  /**
   * Close the RSD catalog connection.
   */
  async close(): Promise<void> {
    this._isClosing = true;
    this.clearServiceExtractionTimer();

    const transport = this._transport;
    if (!transport) {
      return;
    }

    this._isConnected = false;
    await transport.close();
    this.cleanupResources();
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

    const clearAllTimers = (): void => {
      clearTimeout(operationTimer);
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
      this.forceCleanup();
      settleFailure(
        new Error(`Connection timed out after ${operationTimeoutMs}ms`),
      );
    }, operationTimeoutMs);

    return {
      settleSuccess,
      settleFailure,
      isSettled: () => settled,
    };
  }

  private registerTransportHandlers(
    session: ConnectSession,
    transport: RemoteXpcFramedTransport,
  ): void {
    transport.once('error', (error: Error) => {
      if (!this._isClosing) {
        log.error(`Connection error: ${error}`);
      }
      this._isConnected = false;
      session.settleFailure(error);
    });

    transport.on('message', (body) =>
      this.processIncomingMessage(session, body),
    );

    transport.once('close', () => {
      this._isConnected = false;

      if (!session.isSettled()) {
        session.settleFailure(
          new Error('Connection closed before services were extracted'),
        );
      }
    });
  }

  private processIncomingMessage(
    session: ConnectSession,
    body: Parameters<typeof servicesFromXpcBody>[0],
  ): void {
    if (session.isSettled()) {
      return;
    }

    const servicesResponse = servicesFromXpcBody(body);
    if (servicesResponse) {
      session.settleSuccess(servicesResponse);
    }
  }

  private async connectTransport(
    session: ConnectSession,
    transport: RemoteXpcFramedTransport,
    operationTimeoutMs: number,
  ): Promise<void> {
    try {
      await transport.connect({
        timeoutMs: operationTimeoutMs,
        handshakeDelayMs: HANDSHAKE_DELAY_MS,
      });
      this._isConnected = true;
      this.schedulePostHandshakeServiceTimeout(session);
    } catch (error) {
      log.error(`Handshake failed: ${error}`);
      session.settleFailure(error);
      await this.close();
    }
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

  /**
   * Clean up all resources
   */
  private cleanupResources(): void {
    if (this._serviceExtractionTimer) {
      clearTimeout(this._serviceExtractionTimer);
      this._serviceExtractionTimer = undefined;
    }
    this._transport = undefined;
    this._isConnected = false;
    this._isClosing = false;
    this._services = undefined;
  }

  /**
   * Force cleanup by destroying the socket and cleaning up resources
   */
  private forceCleanup(): void {
    try {
      if (this._transport) {
        void this._transport.close();
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

export { RsdServiceCatalogClient, type Service, type ServicesResponse };
