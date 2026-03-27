import type { Socket } from 'node:net';

/**
 * Function signature for opening an upstream device socket.
 */
export type UpstreamSocketConnector = () => Promise<Socket>;

/**
 * Function signature for parameterized connector factories.
 */
export type PortForwardingConnector = (
  udid: string,
  devicePort: number,
  connectTimeoutMs?: number,
) => Promise<Socket>;

/**
 * Options for {@link DevicePortForwarder}.
 */
export interface DevicePortForwarderOptions {
  /** Host to bind the local forwarding server to. */
  host?: string;
  /** Connection timeout (milliseconds) when opening the upstream socket. */
  connectTimeoutMs?: number;
  /**
   * Primary strategy used to open upstream sockets.
   */
  primaryConnector: UpstreamSocketConnector;
  /**
   * Optional fallback strategy if primary connection fails.
   * Useful for trying multiple transport strategies.
   */
  fallbackConnector?: UpstreamSocketConnector;
}

export interface DevicePortForwarderEvents {
  started: () => void;
  stopped: () => void;
  clientConnected: (socket: Socket) => void;
  clientDisconnected: (socket: Socket) => void;
  upstreamConnected: (socket: Socket) => void;
  upstreamDisconnected: (socket: Socket) => void;
  upstreamConnectError: (error: unknown) => void;
  error: (error: unknown) => void;
}
