import type { TLSSocket } from 'tls';
import { type TunnelConnection, connectToTunnelLockdown } from 'tuntap-bridge';

/**
 * A wrapper around the tunnel connection that
 * maintains a singleton tunnel instance.
 */
class TunnelManager {
  private tunnelInstance: TunnelConnection | null = null;

  /**
   * Establishes a tunnel connection if not already connected.
   *
   * @param secureServiceSocket - The secure service socket used to create the tunnel.
   * @returns A promise that resolves to the tunnel connection instance.
   */
  async getTunnel(secureServiceSocket: TLSSocket): Promise<TunnelConnection> {
    if (!this.tunnelInstance) {
      this.tunnelInstance = await connectToTunnelLockdown(secureServiceSocket);
    }
    return this.tunnelInstance;
  }

  /**
   * Closes the current tunnel connection and resets the manager.
   *
   * @returns A promise that resolves when the tunnel is closed.
   */
  async closeTunnel(): Promise<void> {
    if (this.tunnelInstance) {
      // Note: The connection interface provides a "closer" function.
      await this.tunnelInstance.closer();
    }
    this.tunnelInstance = null;
  }
}

export default new TunnelManager();
