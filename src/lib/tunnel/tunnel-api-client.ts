import { logger } from '@appium/support';

import type { TunnelRegistry, TunnelRegistryEntry } from '../types.js';

const log = logger.getLogger('TunnelApiClient');

/**
 * API client for tunnel registry operations
 * This client handles communication with the API server for tunnel data
 */
export class TunnelApiClient {
  private apiBaseUrl: string;

  /**
   * Create a new TunnelApiClient
   * @param apiBaseUrl - Base URL for the API server
   */
  constructor(apiBaseUrl: string = 'http://localhost:42314/remotexpc/tunnels') {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Set the API base URL
   * @param url - New base URL for the API server
   */
  setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url;
  }

  /**
   * Get the API base URL
   * @returns The current API base URL
   */
  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  /**
   * Fetch all tunnel registry data from the API server
   * @returns The complete tunnel registry
   */
  async fetchRegistry(): Promise<TunnelRegistry> {
    try {
      const response = await fetch(this.apiBaseUrl);

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistry;
    } catch (error) {
      log.warn(`Failed to fetch tunnel registry from API: ${error}`);
      // Return empty registry as fallback
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
   * Get a specific tunnel by UDID
   * @param udid - Device UDID
   * @returns Tunnel registry entry or null if not found
   */
  async getTunnelByUdid(udid: string): Promise<TunnelRegistryEntry | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/${udid}`);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistryEntry;
    } catch (error) {
      log.warn(`Failed to fetch tunnel for UDID ${udid}: ${error}`);
      return null;
    }
  }

  /**
   * Get tunnel by device ID
   * @param deviceId - Device ID
   * @returns Tunnel registry entry or null if not found
   */
  async getTunnelByDeviceId(
    deviceId: number,
  ): Promise<TunnelRegistryEntry | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/device/${deviceId}`);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistryEntry;
    } catch (error) {
      log.warn(`Failed to fetch tunnel for device ID ${deviceId}: ${error}`);
      return null;
    }
  }

  /**
   * Get all tunnels
   * @returns Array of tunnel registry entries
   */
  async getAllTunnels(): Promise<TunnelRegistryEntry[]> {
    try {
      const registry = await this.fetchRegistry();
      return Object.values(registry.tunnels);
    } catch (error) {
      log.warn(`Failed to fetch all tunnels: ${error}`);
      return [];
    }
  }

  /**
   * Check if a tunnel exists for a specific UDID
   * @param udid - Device UDID
   * @returns True if tunnel exists, false otherwise
   */
  async hasTunnel(udid: string): Promise<boolean> {
    const tunnel = await this.getTunnelByUdid(udid);
    return tunnel !== null;
  }

  /**
   * Get registry metadata
   * @returns Registry metadata
   */
  async getMetadata(): Promise<TunnelRegistry['metadata']> {
    try {
      const registry = await this.fetchRegistry();
      return registry.metadata;
    } catch (error) {
      log.warn(`Failed to fetch registry metadata: ${error}`);
      return {
        lastUpdated: new Date().toISOString(),
        totalTunnels: 0,
        activeTunnels: 0,
      };
    }
  }

  /**
   * Get tunnel connection details formatted for easy use
   * @param udid - Device UDID
   * @returns Connection details or null if tunnel not found
   */
  async getTunnelConnection(udid: string): Promise<{
    host: string;
    port: number;
    udid: string;
    packetStreamPort: number;
  } | null> {
    const tunnel = await this.getTunnelByUdid(udid);
    if (!tunnel) {
      return null;
    }

    return {
      host: tunnel.address,
      port: tunnel.rsdPort,
      udid: tunnel.udid,
      packetStreamPort: tunnel.packetStreamPort,
    };
  }

  /**
   * List all available device UDIDs with tunnels
   * @returns Array of device UDIDs
   */
  async getAvailableDevices(): Promise<string[]> {
    try {
      const registry = await this.fetchRegistry();
      return Object.keys(registry.tunnels);
    } catch (error) {
      log.warn(`Failed to fetch available devices: ${error}`);
      return [];
    }
  }

  /**
   * Update or create a tunnel entry
   * @param entry - Tunnel registry entry to update or create
   * @returns True if successful, false otherwise
   */
  async updateTunnel(entry: TunnelRegistryEntry): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/${entry.udid}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(entry),
      });

      return response.ok;
    } catch (error) {
      log.error(`Failed to update tunnel for UDID ${entry.udid}: ${error}`);
      return false;
    }
  }

  /**
   * Delete a tunnel entry
   * @param udid - Device UDID
   * @returns True if successful, false otherwise
   */
  async deleteTunnel(udid: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/${udid}`, {
        method: 'DELETE',
      });

      return response.ok;
    } catch (error) {
      log.error(`Failed to delete tunnel for UDID ${udid}: ${error}`);
      return false;
    }
  }
}
