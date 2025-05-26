import { logger } from '@appium/support';
import type { ConnectionOptions, TLSSocket } from 'tls';
import { type TunnelConnection, connectToTunnelLockdown } from 'tuntap-bridge';

import { startCoreDeviceProxy } from '../../services/ios/tunnel-service/index.js';
import { createLockdownServiceByUDID } from '../lockdown/index.js';
import RemoteXpcConnection from '../remote-xpc/remote-xpc-connection.js';

const log = logger.getLogger('TunnelManager');

/**
 * Interface for tunnel registry entry
 */
interface TunnelRegistryEntry {
  tunnel: TunnelConnection;
  lastUsed: number;
  isActive: boolean;
  remoteXPC?: RemoteXpcConnection;
}

/**
 * Interface for tunnel and RemoteXPC connection result
 */
interface TunnelResult {
  tunnel: TunnelConnection;
  remoteXPC: RemoteXpcConnection;
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
   * Gets a tunnel connection and RemoteXPC connection for the specified device.
   * Creates a new tunnel connection each time.
   *
   * @param udid - The device UDID (used only for creating the lockdown service)
   * @param tlsOptions - TLS options for upgrading the usbmuxd socket
   * @returns A promise that resolves to an object containing the tunnel connection and RemoteXPC connection
   */
  async createDeviceConnectionPair(
    udid: string,
    tlsOptions: Partial<ConnectionOptions> = {},
  ): Promise<TunnelResult> {
    try {
      // Create lockdown service
      const { lockdownService, device } =
        await createLockdownServiceByUDID(udid);

      // Start CoreDeviceProxy
      const { socket } = await startCoreDeviceProxy(
        lockdownService,
        device.DeviceID,
        device.Properties.SerialNumber,
        tlsOptions,
      );

      // Create a new tunnel
      const tunnel = await this.getTunnel(socket);

      // Create RemoteXPC connection
      const rsdPort = tunnel.RsdPort ?? 0;
      const remoteXPC = new RemoteXpcConnection([tunnel.Address, rsdPort]);

      // Connect to RemoteXPC with delay between retries
      let retries = 3;
      let lastError;

      while (retries > 0) {
        try {
          await remoteXPC.connect();

          // Update the registry entry with the RemoteXPC connection
          const entry = this.tunnelRegistry.get(tunnel.Address);
          if (entry) {
            entry.remoteXPC = remoteXPC;
          }

          return { tunnel, remoteXPC };
        } catch (error) {
          lastError = error;
          log.warn(
            `RemoteXPC connection attempt failed (${retries} retries left): ${error}`,
          );
          retries--;

          // Wait before retrying
          if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }

      // All retries failed
      throw lastError || new Error('Failed to connect to RemoteXPC');
    } catch (error) {
      log.error(`Error getting tunnel for device ${udid}: ${error}`);
      throw error;
    }
  }

  /**
   * Establishes a tunnel connection if not already connected.
   * If a tunnel is already open for the same address, it will be reused.
   *
   * @param secureServiceSocket - The secure service socket used to create the tunnel.
   * @returns A promise that resolves to the tunnel connection instance.
   */
  async getTunnel(secureServiceSocket: TLSSocket): Promise<TunnelConnection> {
    // Create a new tunnel
    const tunnel = await connectToTunnelLockdown(secureServiceSocket);

    // Check if we already have an active tunnel for this address
    const existingTunnel = this.tunnelRegistry.get(tunnel.Address);

    if (existingTunnel?.isActive) {
      log.info(`Reusing existing tunnel for address: ${tunnel.Address}`);

      // Verify the tunnel is still functional
      try {
        // A simple check to see if the tunnel is still functional
        if (tunnel.tunnelManager?.emit instanceof Function) {
          // Close the new tunnel since we're reusing an existing one
          try {
            await tunnel.closer();
          } catch (error) {
            log.warn(`Error closing redundant tunnel: ${error}`);
          }

          // Update the last used timestamp
          existingTunnel.lastUsed = Date.now();
          return existingTunnel.tunnel;
        } else {
          log.warn(
            'Existing tunnel appears to be non-functional, creating a new one',
          );
          // Mark the existing tunnel as inactive
          existingTunnel.isActive = false;
        }
      } catch (error) {
        log.warn(
          `Error checking tunnel functionality: ${error}, creating a new one`,
        );
        // Mark the existing tunnel as inactive
        existingTunnel.isActive = false;
      }
    }

    // Register the new tunnel
    log.info(`Creating new tunnel for address: ${tunnel.Address}`);
    this.tunnelRegistry.set(tunnel.Address, {
      tunnel,
      lastUsed: Date.now(),
      isActive: true,
    });

    return tunnel;
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
        // Close RemoteXPC connection if it exists
        if (entry.remoteXPC) {
          try {
            await entry.remoteXPC.close();
            log.info(`Closed RemoteXPC connection for address: ${address}`);
          } catch (error) {
            log.error(
              `Error closing RemoteXPC connection for address ${address}: ${error}`,
            );
          }
        }

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
}

// Create and export the singleton instance
export const TunnelManager = new TunnelManagerService();
