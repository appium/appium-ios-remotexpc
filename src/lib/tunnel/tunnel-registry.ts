import { logger } from '@appium/support';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const log = logger.getLogger('TunnelRegistry');

/**
 * Interface for tunnel registry entry
 */
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

/**
 * Interface for tunnel registry
 */
export interface TunnelRegistry {
  tunnels: Record<string, TunnelRegistryEntry>;
  metadata: {
    lastUpdated: string;
    totalTunnels: number;
    activeTunnels: number;
  };
}

/**
 * Tunnel Registry Manager - provides easy access to tunnel information
 */
export class TunnelRegistryManager {
  private readonly registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath =
      registryPath ?? join(process.cwd(), 'tunnel-registry.json');
  }

  /**
   * Load tunnel registry from file
   */
  async loadRegistry(): Promise<TunnelRegistry> {
    try {
      const data = await fs.readFile(this.registryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      log.warn(
        `Failed to load tunnel registry from ${this.registryPath}: ${error}`,
      );
      return {
        tunnels: {},
        metadata: {
          lastUpdated: new Date().toISOString(),
          totalTunnels: 0,
          activeTunnels: 0,
        },
      };
    }
  }

  /**
   * Get tunnel information for a specific device by UDID
   */
  async getTunnelByUdid(udid: string): Promise<TunnelRegistryEntry | null> {
    const registry = await this.loadRegistry();
    return registry.tunnels[udid] ?? null;
  }

  /**
   * Get all active tunnels
   */
  async getAllTunnels(): Promise<TunnelRegistryEntry[]> {
    const registry = await this.loadRegistry();
    return Object.values(registry.tunnels);
  }

  /**
   * Get tunnel information for a specific device by Device ID
   */
  async getTunnelByDeviceId(
    deviceId: number,
  ): Promise<TunnelRegistryEntry | null> {
    const registry = await this.loadRegistry();
    const tunnel = Object.values(registry.tunnels).find(
      (tunnel) => tunnel.deviceId === deviceId,
    );
    return tunnel ?? null;
  }

  /**
   * Check if a tunnel exists for a specific UDID
   */
  async hasTunnel(udid: string): Promise<boolean> {
    const tunnel = await this.getTunnelByUdid(udid);
    return tunnel !== null;
  }

  /**
   * Get registry metadata
   */
  async getMetadata(): Promise<TunnelRegistry['metadata']> {
    const registry = await this.loadRegistry();
    return registry.metadata;
  }

  /**
   * Get the registry file path
   */
  getRegistryPath(): string {
    return this.registryPath;
  }

  /**
   * Check if registry file exists
   */
  async registryExists(): Promise<boolean> {
    try {
      await fs.access(this.registryPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get tunnel connection details formatted for easy use
   */
  async getTunnelConnection(udid: string): Promise<{
    host: string;
    port: number;
    udid: string;
  } | null> {
    const tunnel = await this.getTunnelByUdid(udid);
    if (!tunnel) {
      return null;
    }

    return {
      host: tunnel.address,
      port: tunnel.rsdPort,
      udid: tunnel.udid,
    };
  }

  /**
   * List all available device UDIDs with tunnels
   */
  async getAvailableDevices(): Promise<string[]> {
    const registry = await this.loadRegistry();
    return Object.keys(registry.tunnels);
  }
}

/**
 * Default tunnel registry manager instance
 */
export const tunnelRegistry = new TunnelRegistryManager();

/**
 * Convenience functions for quick access
 */

/**
 * Get tunnel information for a device by UDID
 */
export async function getTunnelByUdid(
  udid: string,
): Promise<TunnelRegistryEntry | null> {
  return tunnelRegistry.getTunnelByUdid(udid);
}

/**
 * Get all active tunnels
 */
export async function getAllTunnels(): Promise<TunnelRegistryEntry[]> {
  return tunnelRegistry.getAllTunnels();
}

/**
 * Get tunnel connection details for a device
 */
export async function getTunnelConnection(udid: string): Promise<{
  host: string;
  port: number;
  udid: string;
} | null> {
  return tunnelRegistry.getTunnelConnection(udid);
}

/**
 * Check if a tunnel exists for a device
 */
export async function hasTunnel(udid: string): Promise<boolean> {
  return tunnelRegistry.hasTunnel(udid);
}

/**
 * Get list of all device UDIDs with active tunnels
 */
export async function getAvailableDevices(): Promise<string[]> {
  return tunnelRegistry.getAvailableDevices();
}
