import { getLogger } from '../logger.js';
import type { TunnelRegistry, TunnelRegistryEntry } from '../types.js';

const log = getLogger('TunnelApiClient');

const EMPTY_REGISTRY: TunnelRegistry = {
  tunnels: {},
  metadata: {
    lastUpdated: new Date().toISOString(),
    totalTunnels: 0,
    activeTunnels: 0,
  },
};
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * API client for tunnel registry operations
 * This client handles communication with the API server for tunnel data
 */
export class TunnelApiClient {
  private readonly apiBaseUrl: string;
  private readonly strict: boolean;
  private readonly timeoutMs: number;

  /**
   * Create a new TunnelApiClient
   * @param apiBaseUrl - Base URL for the API server
   * @param options - Optional settings
   */
  constructor(apiBaseUrl: string, options: TunnelApiClientOptions = {}) {
    this.apiBaseUrl = apiBaseUrl;
    this.strict = options.strict ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      const response = await this.fetchWithTimeout(this.apiBaseUrl);

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistry;
    } catch (error) {
      this.handleFetchError('Failed to fetch tunnel registry from API', error);
      return EMPTY_REGISTRY;
    }
  }

  /**
   * Get a specific tunnel by UDID
   * @param udid - Device UDID
   * @returns Tunnel registry entry or null if not found
   */
  async getTunnelByUdid(udid: string): Promise<TunnelRegistryEntry | null> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.apiBaseUrl}/${udid}`,
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistryEntry;
    } catch (error) {
      this.handleFetchError(`Failed to fetch tunnel for UDID ${udid}`, error);
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
      const response = await this.fetchWithTimeout(
        `${this.apiBaseUrl}/device/${deviceId}`,
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      return (await response.json()) as TunnelRegistryEntry;
    } catch (error) {
      this.handleFetchError(
        `Failed to fetch tunnel for device ID ${deviceId}`,
        error,
      );
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
      this.handleFetchError('Failed to fetch all tunnels', error);
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
      this.handleFetchError('Failed to fetch registry metadata', error);
      return EMPTY_REGISTRY.metadata;
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
    packetStreamPort: number | undefined;
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
      this.handleFetchError('Failed to fetch available devices', error);
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
      const response = await this.fetchWithTimeout(
        `${this.apiBaseUrl}/${entry.udid}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(entry),
        },
      );

      return response.ok;
    } catch (error) {
      this.handleFetchError(
        `Failed to update tunnel for UDID ${entry.udid}`,
        error,
        'error',
      );
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
      const response = await this.fetchWithTimeout(
        `${this.apiBaseUrl}/${udid}`,
        { method: 'DELETE' },
      );

      return response.ok;
    } catch (error) {
      this.handleFetchError(
        `Failed to delete tunnel for UDID ${udid}`,
        error,
        'error',
      );
      return false;
    }
  }

  /**
   * On strict: throws Error with message and cause. Otherwise logs and returns.
   */
  private handleFetchError(
    messagePrefix: string,
    error: unknown,
    logLevel: 'warn' | 'error' = 'warn',
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${messagePrefix}: ${detail}`;
    if (this.strict) {
      throw new Error(message, { cause: error });
    }
    if (logLevel === 'error') {
      log.error(message);
    } else {
      log.warn(message);
    }
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Tunnel registry request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export interface TunnelApiClientOptions {
  /** When true, methods throw on fetch/API errors instead of returning fallback values. Default false. */
  strict?: boolean;
  /** Request timeout in milliseconds. Default 10000 (10 seconds). */
  timeoutMs?: number;
}
