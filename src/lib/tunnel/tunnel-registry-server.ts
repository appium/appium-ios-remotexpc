import { logger } from '@appium/support';
import * as http from 'node:http';
import { URL } from 'node:url';

// Constants
const DEFAULT_TUNNEL_REGISTRY_PORT = 42314;
const DEFAULT_SERVER_PORT = 4723;
const API_BASE_PATH = '/remotexpc/tunnels';

// HTTP Status Codes
const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
} as const;

// Interfaces
export interface TunnelRegistryEntry {
  /** Unique device identifier */
  udid: string;
  /** Numeric device ID */
  deviceId: number;
  /** IP address of the tunnel */
  address: string;
  /** Remote Service Discovery (RSD) port number */
  rsdPort: number;
  /** Optional packet stream port number */
  packetStreamPort?: number;
  /** Type of connection (e.g., 'USB', 'Network') */
  connectionType: string;
  /** Product identifier of the device */
  productId: number;
  /** Timestamp when the tunnel was created (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when the tunnel was last updated (milliseconds since epoch) */
  lastUpdated: number;
}

export interface TunnelRegistry {
  /** Map of UDID to tunnel registry entries */
  tunnels: Record<string, TunnelRegistryEntry>;
  /** Metadata about the registry */
  metadata: {
    /** ISO 8601 timestamp of last registry update */
    lastUpdated: string;
    /** Total number of tunnels in the registry */
    totalTunnels: number;
    /** Number of currently active tunnels */
    activeTunnels: number;
  };
}

// Logger instance
const log = logger.getLogger('TunnelRegistryServer');

// Helper functions
/**
 * Parse JSON body from HTTP request
 */
async function parseJSONBody<T = unknown>(
  req: http.IncomingMessage,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJSON(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Tunnel Registry Server - provides API endpoints for tunnel registry operations
 */
export class TunnelRegistryServer {
  private server: http.Server | undefined;
  public port: number;
  public tunnelsInfo: TunnelRegistry | string | undefined;
  private registry: TunnelRegistry = {
    tunnels: {},
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalTunnels: 0,
      activeTunnels: 0,
    },
  };

  /**
   * Create a new TunnelRegistryServer
   * @param tunnelsInfo - Registry data or path to the registry file
   * @param port - Port to listen on
   */
  constructor(
    tunnelsInfo: TunnelRegistry | string | undefined,
    port: number = DEFAULT_SERVER_PORT,
  ) {
    this.port = port;
    this.tunnelsInfo = tunnelsInfo;
  }

  /**
   * Get tunnels from registry
   */
  private get tunnels(): Record<string, TunnelRegistryEntry> {
    return this.registry.tunnels;
  }

  /**
   * Get auto-calculated metadata
   */
  private get metadata(): TunnelRegistry['metadata'] {
    const tunnelCount = Object.keys(this.tunnels).length;
    return {
      lastUpdated: new Date().toISOString(),
      totalTunnels: tunnelCount,
      activeTunnels: tunnelCount, // Assuming all tunnels are active
    };
  }

  /**
   * Get a complete registry with tunnels and metadata
   */
  private get fullRegistry(): TunnelRegistry {
    return {
      tunnels: this.tunnels,
      metadata: this.metadata,
    };
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    try {
      // Load the registry first
      await this.loadRegistry();

      // Create HTTP server with request handler
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.server?.listen(this.port, () => {
          log.info(`Tunnel Registry Server started on port ${this.port}`);
          log.info(
            `API available at http://localhost:${this.port}${API_BASE_PATH}`,
          );
          resolve();
        });

        // Handle server errors
        this.server?.on('error', (error) => {
          log.error(`Server error: ${error}`);
          reject(error);
        });
      });
    } catch (error) {
      log.error(`Failed to start server: ${error}`);
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      log.warn('Server not running');
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      log.info('Tunnel Registry Server stopped');
    } catch (error) {
      log.error(`Error stopping server: ${error}`);
      throw error;
    }
  }

  /**
   * Main request handler
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);
    const method = req.method || 'GET';
    const pathname = url.pathname;

    // Log the request
    log.debug(`${method} ${pathname}`);

    // Match routes
    const basePath = API_BASE_PATH;

    try {
      // GET /remotexpc/tunnels - Get all tunnels
      if (method === 'GET' && pathname === basePath) {
        await this.getAllTunnels(res);
        return;
      }

      // GET /remotexpc/tunnels/device/:deviceId - Get tunnel by device ID
      const deviceMatch = pathname.match(
        new RegExp(`^${basePath}/device/(.+)$`),
      );
      if (method === 'GET' && deviceMatch) {
        const deviceIdStr = deviceMatch[1];
        const deviceId = parseInt(deviceIdStr, 10);
        await this.getTunnelByDeviceId(res, deviceId);
        return;
      }

      // GET /remotexpc/tunnels/:udid - Get tunnel by UDID
      const udidMatch = pathname.match(new RegExp(`^${basePath}/([^/]+)$`));
      if (
        method === 'GET' &&
        udidMatch &&
        !udidMatch[1].startsWith('device/')
      ) {
        const udid = udidMatch[1];
        await this.getTunnelByUdid(res, udid);
        return;
      }

      // PUT /remotexpc/tunnels/:udid - Update tunnel
      if (method === 'PUT' && udidMatch) {
        const udid = udidMatch[1];
        await this.updateTunnel(req, res, udid);
        return;
      }

      // No route matched
      sendJSON(res, HTTP_STATUS.NOT_FOUND, { error: 'Not found' });
    } catch (error) {
      log.error(`Request handling error: ${error}`);
      sendJSON(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: 'Internal server error',
      });
    }
  }

  /**
   * Handler for getting all tunnels
   */
  private async getAllTunnels(res: http.ServerResponse): Promise<void> {
    try {
      await this.loadRegistry();
      sendJSON(res, HTTP_STATUS.OK, this.fullRegistry);
    } catch (error) {
      log.error(`Error getting all tunnels: ${error}`);
      sendJSON(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: 'Failed to get tunnels',
      });
    }
  }

  /**
   * Handler for getting a tunnel by UDID
   */
  private async getTunnelByUdid(
    res: http.ServerResponse,
    udid: string,
  ): Promise<void> {
    try {
      await this.loadRegistry();
      const tunnel = this.tunnels[udid];

      if (!tunnel) {
        sendJSON(res, HTTP_STATUS.NOT_FOUND, {
          error: `Tunnel not found for UDID: ${udid}`,
        });
        return;
      }

      sendJSON(res, HTTP_STATUS.OK, tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by UDID: ${error}`);
      sendJSON(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: 'Failed to get tunnel',
      });
    }
  }

  /**
   * Handler for getting a tunnel by device ID
   */
  private async getTunnelByDeviceId(
    res: http.ServerResponse,
    deviceId: number,
  ): Promise<void> {
    try {
      await this.loadRegistry();

      if (isNaN(deviceId)) {
        sendJSON(res, HTTP_STATUS.BAD_REQUEST, { error: 'Invalid device ID' });
        return;
      }

      const tunnel = Object.values(this.tunnels).find(
        (t) => t.deviceId === deviceId,
      );

      if (!tunnel) {
        sendJSON(res, HTTP_STATUS.NOT_FOUND, {
          error: `Tunnel not found for device ID: ${deviceId}`,
        });
        return;
      }

      sendJSON(res, HTTP_STATUS.OK, tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by device ID: ${error}`);
      sendJSON(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: 'Failed to get tunnel',
      });
    }
  }

  /**
   * Handler for updating a tunnel
   */
  private async updateTunnel(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    udid: string,
  ): Promise<void> {
    try {
      await this.loadRegistry();
      const tunnelData = await parseJSONBody<TunnelRegistryEntry>(req);

      if (!tunnelData || typeof tunnelData !== 'object') {
        sendJSON(res, HTTP_STATUS.BAD_REQUEST, {
          error: 'Invalid tunnel data',
        });
        return;
      }

      // Ensure the UDID in the path matches the one in the body
      if (tunnelData.udid !== udid) {
        sendJSON(res, HTTP_STATUS.BAD_REQUEST, {
          error: 'UDID mismatch between path and body',
        });
        return;
      }

      // Update the tunnel
      this.registry.tunnels[udid] = {
        ...tunnelData,
        lastUpdated: Date.now(),
      };

      sendJSON(res, HTTP_STATUS.OK, {
        success: true,
        tunnel: this.registry.tunnels[udid],
      });
    } catch (error) {
      log.error(`Error updating tunnel: ${error}`);
      sendJSON(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        error: 'Failed to update tunnel',
      });
    }
  }

  /**
   * Load the registry from a file
   */
  private async loadRegistry(): Promise<void> {
    try {
      if (this.tunnelsInfo && typeof this.tunnelsInfo !== 'string') {
        this.registry = this.tunnelsInfo;
      }
      // If tunnelsInfo is a string (file path), we would load from a file here
      // For now, we're just using the object directly
    } catch (error) {
      log.warn(`Failed to load registry: ${error}`);
      // If the file doesn't exist or is invalid, use the default empty registry
      this.registry = {
        tunnels: {},
        metadata: {
          lastUpdated: new Date().toISOString(),
          totalTunnels: 0,
          activeTunnels: 0,
        },
      };
    }
  }
}

/**
 * Create and start a TunnelRegistryServer instance
 * @param tunnelInfos - Registry data or path
 * @param port - Port to listen on
 * @returns The started TunnelRegistryServer instance
 */
export async function startTunnelRegistryServer(
  tunnelInfos: TunnelRegistry | string | undefined,
  port: number = DEFAULT_TUNNEL_REGISTRY_PORT,
): Promise<TunnelRegistryServer> {
  const server = new TunnelRegistryServer(tunnelInfos, port);
  await server.start();
  return server;
}
