import {
  type TunnelConnection,
  connectToTunnelLockdown,
} from 'appium-ios-tuntap';
import type { TLSSocket } from 'node:tls';

import { getLogger } from '../logger.js';
import {
  CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS,
  RemoteXpcConnection,
} from '../remote-xpc/remote-xpc-connection.js';
import { runSerializedRsdSession } from './rsd-session-lock.js';

const log = getLogger('TunnelManager');

/** Retry once when remoted is busy or a discovery attempt times out. */
const REMOTED_RACE_MAX_ATTEMPTS = 2;
const REMOTED_RACE_RETRY_DELAY_MS = 250;

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
   * Run `fn` while holding the per-tunnel RSD discovery lock (connect → discover → close).
   */
  async runSerializedRsdSession<T>(
    lockKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return await runSerializedRsdSession(lockKey, fn);
  }

  /**
   * Connect to RSD without acquiring the session lock (caller must hold the lock).
   */
  async connectRemoteXPCUnlocked(
    address: string,
    rsdPort: number,
  ): Promise<RemoteXpcConnection> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= REMOTED_RACE_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, REMOTED_RACE_RETRY_DELAY_MS),
        );
      }

      const remoteXPC = new RemoteXpcConnection([address, rsdPort]);
      try {
        await remoteXPC.connect({
          timeoutMs: CONNECTION_DEFAULT_OPERATION_TIMEOUT_MS,
        });

        return remoteXPC;
      } catch (error) {
        lastError = error;
        await remoteXPC.close().catch(() => {});
        if (
          attempt >= REMOTED_RACE_MAX_ATTEMPTS ||
          !isRemotedRaceError(error)
        ) {
          break;
        }
        log.warn(
          `RemoteXPC connection attempt ${attempt} failed (remoted race), retrying: ${error}`,
        );
      }
    }

    log.error(`Error for device ${address}: ${lastError}`);
    throw lastError ?? new Error('Failed to connect to RemoteXPC');
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

function isRemotedRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes('ECONNRESET') ||
    message.includes('Connection timed out') ||
    message.includes('Connection closed before services were extracted') ||
    message.includes('No services received after handshake')
  );
}

// Create and export the singleton instance
export const TunnelManager = new TunnelManagerService();
export { isRsdDiscoveryBusy, rsdSessionLockKey } from './rsd-session-lock.js';
// Export packet streaming IPC functionality
export { PacketStreamClient } from './packet-stream-client.js';
export { PacketStreamServer } from './packet-stream-server.js';
export {
  watchTunnelRegistrySockets,
  type TunnelRegistrySocketWatch,
  type WatchTunnelRegistryOptions,
} from './tunnel-registry-lifecycle.js';
// Re-export TunnelConnection type from appium-ios-tuntap
export type { TunnelConnection };
