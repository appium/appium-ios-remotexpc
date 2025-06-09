import { logger } from '@appium/support';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

const log = logger.getLogger('TunnelRegistryServer');

export interface TunnelRegistryEntry {
  udid: string;
  deviceId: number;
  address: string;
  rsdPort: number;
  packetStreamPort?: number;
  connectionType: string;
  productId: number;
  createdAt: number;
  lastUpdated: number;
}

export interface TunnelRegistry {
  tunnels: Record<string, TunnelRegistryEntry>;
  metadata: {
    lastUpdated: string;
    totalTunnels: number;
    activeTunnels: number;
  };
}

/**
 * Tunnel Registry Server - provides API endpoints for tunnel registry operations
 */
export class TunnelRegistryServer {
  private app: express.Application;
  private server: any;
  public port: number;
  public tunnelsInfo: any;
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
   * @param port - Port to listen on
   * @param tunnelsInfo - Path to the registry file
   */
  constructor(tunnelsInfo: string | undefined, port: number = 4723) {
    this.port = port;
    this.tunnelsInfo = tunnelsInfo;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Load the registry first
        this.loadRegistry()
          .then(() => {
            // Start the server
            this.server = this.app.listen(this.port, () => {
              log.info(`Tunnel Registry Server started on port ${this.port}`);
              log.info(
                `API available at http://localhost:${this.port}/remotexpc/tunnels`,
              );
              resolve();
            });
            return undefined; // Return a value to satisfy the linter
          })
          .catch((error) => {
            log.error(`Failed to load registry: ${error}`);
            reject(error);
          });
      } catch (error) {
        log.error(`Failed to start server: ${error}`);
        reject(error);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        log.warn('Server not running');
        return resolve();
      }

      this.server.close((error: Error) => {
        if (error) {
          log.error(`Error stopping server: ${error}`);
          return reject(error);
        }
        log.info('Tunnel Registry Server stopped');
        resolve();
      });
    });
  }

  /**
   * Setup middleware for the Express app
   */
  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      log.debug(`${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Setup routes for the Express app
   */
  private setupRoutes(): void {
    // Base path for the API
    const basePath = '/remotexpc/tunnels';

    // Get all tunnels
    this.app.get(basePath, this.getAllTunnels.bind(this));

    // Get a specific tunnel by UDID
    this.app.get(`${basePath}/:udid`, this.getTunnelByUdid.bind(this));

    // Get a specific tunnel by device ID
    this.app.get(
      `${basePath}/device/:deviceId`,
      this.getTunnelByDeviceId.bind(this),
    );

    // Create or update a tunnel
    this.app.put(`${basePath}/:udid`, this.updateTunnel.bind(this));
  }

  /**
   * Handler for getting all tunnels
   */
  private async getAllTunnels(req: Request, res: Response): Promise<void> {
    try {
      await this.loadRegistry();
      res.json(this.registry);
    } catch (error) {
      log.error(`Error getting all tunnels: ${error}`);
      res.status(500).json({ error: 'Failed to get tunnels' });
    }
  }

  /**
   * Handler for getting a tunnel by UDID
   */
  private async getTunnelByUdid(req: Request, res: Response): Promise<void> {
    try {
      await this.loadRegistry();
      const { udid } = req.params;
      const tunnel = this.registry.tunnels[udid];

      if (!tunnel) {
        res.status(404).json({ error: `Tunnel not found for UDID: ${udid}` });
        return;
      }

      res.json(tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by UDID: ${error}`);
      res.status(500).json({ error: 'Failed to get tunnel' });
    }
  }

  /**
   * Handler for getting a tunnel by device ID
   */
  private async getTunnelByDeviceId(
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      await this.loadRegistry();
      const deviceId = parseInt(req.params.deviceId, 10);

      if (isNaN(deviceId)) {
        res.status(400).json({ error: 'Invalid device ID' });
        return;
      }

      const tunnel = Object.values(this.registry.tunnels).find(
        (t) => t.deviceId === deviceId,
      );

      if (!tunnel) {
        res
          .status(404)
          .json({ error: `Tunnel not found for device ID: ${deviceId}` });
        return;
      }

      res.json(tunnel);
    } catch (error) {
      log.error(`Error getting tunnel by device ID: ${error}`);
      res.status(500).json({ error: 'Failed to get tunnel' });
    }
  }

  /**
   * Handler for updating a tunnel
   */
  private async updateTunnel(req: Request, res: Response): Promise<void> {
    try {
      await this.loadRegistry();
      const { udid } = req.params;
      const tunnelData = req.body as TunnelRegistryEntry;

      if (!tunnelData || typeof tunnelData !== 'object') {
        res.status(400).json({ error: 'Invalid tunnel data' });
        return;
      }

      // Ensure the UDID in the path matches the one in the body
      if (tunnelData.udid !== udid) {
        res.status(400).json({ error: 'UDID mismatch between path and body' });
        return;
      }

      // Update the tunnel
      this.registry.tunnels[udid] = {
        ...tunnelData,
        lastUpdated: Date.now(),
      };

      // Update metadata
      this.updateMetadata();

      res.json({ success: true, tunnel: this.registry.tunnels[udid] });
    } catch (error) {
      log.error(`Error updating tunnel: ${error}`);
      res.status(500).json({ error: 'Failed to update tunnel' });
    }
  }

  /**
   * Update the registry metadata
   */
  private updateMetadata(): void {
    const tunnelCount = Object.keys(this.registry.tunnels).length;
    this.registry.metadata = {
      lastUpdated: new Date().toISOString(),
      totalTunnels: tunnelCount,
      activeTunnels: tunnelCount, // Assuming all tunnels are active
    };
  }

  /**
   * Load the registry from file
   */
  private async loadRegistry(): Promise<void> {
    try {
      if (this.tunnelsInfo) {
        this.registry = this.tunnelsInfo as TunnelRegistry;
      }
    } catch (error) {
      log.warn(`Failed to load registry from ${this.tunnelsInfo}: ${error}`);
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
 * @param port - Port to listen on
 * @param registryPath - Path to the registry file
 * @returns The started TunnelRegistryServer instance
 */
export async function startTunnelRegistryServer(
  tunnelInfos: any,
  port: number = 42314,
): Promise<TunnelRegistryServer> {
  const server = new TunnelRegistryServer(tunnelInfos, port);
  await server.start();
  return server;
}
