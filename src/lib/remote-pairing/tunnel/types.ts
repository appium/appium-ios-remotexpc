import type * as tls from 'node:tls';

export interface TcpListenerInfo {
  port: number;
  serviceName: string;
  devicePublicKey: string;
}

/**
 * Extended TLS connection options that include PSK (Pre-Shared Key) callback support.
 * This interface extends the standard Node.js TLS ConnectionOptions to add PSK authentication.
 */
export interface TlsPskConnectionOptions extends tls.ConnectionOptions {
  /**
   * Callback function invoked during TLS handshake to provide PSK credentials.
   * @param hint - Optional hint from the server about which PSK identity to use
   * @returns Object containing the pre-shared key and identity string
   */
  pskCallback?: (hint: string | null) => {
    psk: Buffer;
    identity: string;
  };
}
