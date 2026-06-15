import {
  type TunnelConnection,
  type TunnelLockdownTlsCredentials,
  type TunnelPskTlsCredentials,
  connectToTunnelLockdown,
  connectToTunnelPsk,
} from 'appium-ios-tuntap';
import type { Socket } from 'node:net';

import { getLogger } from '../logger.js';

const log = getLogger('TunnelManager');

/**
 * Interface for tunnel registry entry
 */
interface TunnelRegistryEntry {
  tunnel: TunnelConnection;
  lastUsed: number;
  isActive: boolean;
}

/**
 * A wrapper around the tunnel connection that
 * maintains a registry of active tunnels that can be reused.
 */
class TunnelManagerService {
  // Map of tunnel address to tunnel registry entry
  private tunnelRegistry: Map<string, TunnelRegistryEntry> = new Map();
  /**
   * Checks if a tunnel is already open for the given address
   *
   * @param address - The tunnel address to check
   * @returns True if a tunnel is open for the address, false otherwise
   */
  isTunnelOpen(address: string): boolean {
    const entry = this.tunnelRegistry.get(address);
    return Boolean(entry?.isActive);
  }

  /**
   * Gets all active tunnels
   *
   * @returns Array of active tunnel addresses
   */
  getActiveTunnels(): string[] {
    return Array.from(this.tunnelRegistry.entries())
      .filter(([, entry]) => entry.isActive)
      .map(([address]) => address);
  }

  /**
   * Establishes a tunnel via native OpenSSL forwarding (raw TCP + pair-record PEM).
   */
  async getTunnel(
    tcpSocket: Socket,
    credentials: TunnelLockdownTlsCredentials,
    options?: { onDead?: (reason: string) => void },
  ): Promise<TunnelConnection> {
    const tunnel = await connectToTunnelLockdown(
      tcpSocket,
      credentials,
      options,
    );
    return this.registerTunnel(tunnel, 'tunnel');
  }

  /**
   * Establishes an Apple TV tunnel via native OpenSSL TLS-PSK forwarding.
   */
  async getTunnelPsk(
    tcpSocket: Socket,
    credentials: TunnelPskTlsCredentials,
    options?: { onDead?: (reason: string) => void },
  ): Promise<TunnelConnection> {
    const tunnel = await connectToTunnelPsk(tcpSocket, credentials, options);
    return this.registerTunnel(tunnel, 'Apple TV tunnel');
  }

  /**
   * Gets an existing tunnel by address if available
   *
   * @param address - The tunnel address
   * @returns The tunnel if found and active, null otherwise
   */
  getTunnelByAddress(address: string): TunnelConnection | null {
    const entry = this.tunnelRegistry.get(address);
    if (entry?.isActive) {
      // Update the last used timestamp
      entry.lastUsed = Date.now();
      return entry.tunnel;
    }
    return null;
  }

  /**
   * Closes a specific tunnel connection by address.
   *
   * @param address - The address of the tunnel to close
   * @returns A promise that resolves when the tunnel is closed.
   */
  async closeTunnelByAddress(address: string): Promise<void> {
    const entry = this.tunnelRegistry.get(address);
    if (entry?.isActive) {
      try {
        // Close the tunnel
        try {
          await entry.tunnel.closer();
          log.info(`Closed tunnel for address: ${address}`);
        } catch (error) {
          log.error(`Error closing tunnel for address ${address}: ${error}`);
        } finally {
          entry.isActive = false;
          log.info(`Marked tunnel for address ${address} as inactive`);
        }
      } catch (error) {
        log.error(`Error closing tunnel for address ${address}: ${error}`);
      }
    }
  }

  /**
   * Closes all tunnel connections and resets the registry.
   *
   * @returns A promise that resolves when all tunnels are closed.
   */
  async closeAllTunnels(): Promise<void> {
    const closePromises = Array.from(this.tunnelRegistry.entries())
      .filter(([, entry]) => entry.isActive)
      .map(([address]) => this.closeTunnelByAddress(address));

    if (closePromises.length > 0) {
      await Promise.all(closePromises);
    }

    this.tunnelRegistry.clear();
    log.info('All tunnels closed');
  }

  /**
   * Closes the tunnel connection for backward compatibility.
   * This method is kept for backward compatibility with existing code.
   *
   * @returns A promise that resolves when all tunnels are closed.
   */
  async closeTunnel(): Promise<void> {
    return this.closeAllTunnels();
  }

  private async registerTunnel(
    tunnel: TunnelConnection,
    kindLabel: string,
  ): Promise<TunnelConnection> {
    const existingTunnel = this.tunnelRegistry.get(tunnel.Address);
    if (existingTunnel?.isActive) {
      log.info(`Reusing existing tunnel for address: ${tunnel.Address}`);
      try {
        if (tunnel.tunnelManager) {
          try {
            await tunnel.closer();
          } catch (error) {
            log.warn(`Error closing redundant tunnel: ${error}`);
          }
          existingTunnel.lastUsed = Date.now();
          return existingTunnel.tunnel;
        }
      } catch (error) {
        log.warn(
          `Error checking tunnel functionality: ${error}, creating a new one`,
        );
        existingTunnel.isActive = false;
      }
    }

    log.info(`Creating new ${kindLabel} for address: ${tunnel.Address}`);
    this.tunnelRegistry.set(tunnel.Address, {
      tunnel,
      lastUsed: Date.now(),
      isActive: true,
    });

    return tunnel;
  }
}

// Create and export the singleton instance
export const TunnelManager = new TunnelManagerService();
export { discoverServices, servicesToCatalog } from './tunnel-rsd-discovery.js';
export { TunnelReadinessCoordinator } from './tunnel-readiness.js';
export {
  watchTunnelRegistrySockets,
  watchTunnelRegistryOnDead,
  type TunnelRegistrySocketWatch,
  type TunnelRegistryOnDeadWatch,
  type WatchTunnelRegistryOptions,
  type WatchTunnelRegistryOnDeadOptions,
} from './tunnel-registry-lifecycle.js';
// Re-export TunnelConnection type from appium-ios-tuntap
export type { TunnelConnection };
