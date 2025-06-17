import { logger } from '@appium/support';
import * as http from 'node:http';
import { URL } from 'node:url';

import type { TunnelRegistry, TunnelRegistryEntry } from '../types.js';

// Constants
const DEFAULT_TUNNEL_REGISTRY_PORT = 42314;
const API_BASE_PATH = '/remotexpc/tunnels';

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
  const statusText = http.STATUS_CODES[statusCode] || '';
  let responseBody;
  if (data && typeof data === 'object' && data !== null) {
    if ('error' in data) {
      responseBody = { status: statusText, ...data };
    } else {
      responseBody = { status: statusText, ...data };
    }
  } else {
    responseBody = { status: statusText, data };
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(responseBody));
}

/**
 * Tunnel Registry Server - provides API endpoints for tunnel registry operations
 */
export class TunnelRegistryServer {
  private server?: http.Server;
  public port: number;
  public tunnelsInfo?: TunnelRegistry;
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
   * @param tunnelsInfo - Registry data object
   * @param port - Port to listen on
   */
  constructor(tunnelsInfo: TunnelRegistry | undefined, port: number) {
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
      sendJSON(res, 404, { error: 'Not found' });
    } catch (error) {
      log.error(`Request handling error: ${error}`);
      sendJSON(res, 500, {
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
      sendJSON(res, 200, this.fullRegistry);
    } catch (error) {
      log.error(`Error getting all tunnels: ${error}`);
      sendJSON(res, 500, {
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
        sendJSON(res, 404, {
          error: `Tunnel not found for UDID: ${udid}`,
        });
        return;
      }

      sendJSON(res, 200, tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by UDID: ${error}`);
      sendJSON(res, 500, {
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
        sendJSON(res, 400, { error: 'Invalid device ID' });
        return;
      }

      const tunnel = Object.values(this.tunnels).find(
        (t) => t.deviceId === deviceId,
      );

      if (!tunnel) {
        sendJSON(res, 404, {
          error: `Tunnel not found for device ID: ${deviceId}`,
        });
        return;
      }

      sendJSON(res, 200, tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by device ID: ${error}`);
      sendJSON(res, 500, {
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
      let tunnelData: TunnelRegistryEntry | null = null;
      try {
        tunnelData = await parseJSONBody<TunnelRegistryEntry>(req);
      } catch (parseError: unknown) {
        const errorMessage =
          parseError instanceof Error ? parseError.message : String(parseError);
        log.error(`Failed to parse JSON body: ${errorMessage}`);
        sendJSON(res, 400, {
          error: 'Malformed JSON in request body',
        });
        return;
      }

      if (!tunnelData || typeof tunnelData !== 'object') {
        sendJSON(res, 400, {
          error: 'Invalid tunnel data',
        });
        return;
      }

      // Ensure the UDID in the path matches the one in the body
      if (tunnelData.udid !== udid) {
        sendJSON(res, 400, {
          error: 'UDID mismatch between path and body',
        });
        return;
      }

      // Update the tunnel
      this.registry.tunnels[udid] = {
        ...tunnelData,
        lastUpdated: Date.now(),
      };

      sendJSON(res, 200, {
        success: true,
        tunnel: this.registry.tunnels[udid],
      });
    } catch (error) {
      log.error(`Error updating tunnel: ${error}`);
      sendJSON(res, 500, {
        error: 'Failed to update tunnel',
      });
    }
  }

  /**
   * Load the registry from provided data
   */
  private async loadRegistry(): Promise<void> {
    try {
      if (this.tunnelsInfo) {
        this.registry = this.tunnelsInfo;
      }
      // Use the provided registry object or default empty registry
    } catch (error) {
      log.warn(`Failed to load registry: ${error}`);
      // If there's an error, use the default empty registry
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
 * @param tunnelInfos - Registry data object
 * @param port - Port to listen on
 * @returns The started TunnelRegistryServer instance
 */
export async function startTunnelRegistryServer(
  tunnelInfos: TunnelRegistry | undefined,
  port: number = DEFAULT_TUNNEL_REGISTRY_PORT,
): Promise<TunnelRegistryServer> {
  const server = new TunnelRegistryServer(tunnelInfos, port);
  await server.start();
  return server;
}
