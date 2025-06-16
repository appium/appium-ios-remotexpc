/**
 * Common type definitions for the appium-ios-remotexpc library
 */
import type { Device } from './usbmux/index.js';

/**
 * Represents a value that can be stored in a plist
 */
export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | PlistArray
  | PlistDictionary
  | null;

/**
 * Represents an array in a plist
 */
export type PlistArray = Array<PlistValue>;

/**
 * Represents a dictionary in a plist
 */
export interface PlistDictionary {
  [key: string]: PlistValue;
}

/**
 * Represents a message that can be sent or received via plist
 */
export type PlistMessage = PlistDictionary;

/**
 * Represents a value that can be encoded in XPC protocol
 */
export type XPCValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | Uint8Array
  | XPCArray
  | XPCDictionary
  | null;

/**
 * Represents an array in XPC protocol
 */
export type XPCArray = Array<XPCValue>;

/**
 * Represents a dictionary in XPC protocol
 */
export interface XPCDictionary {
  [key: string]: XPCValue;
}

/**
 * Represents a callback function for handling responses
 */
export type ResponseCallback<T> = (data: T) => void;

export interface TunnelRegistryEntry {
  /** Unique device identifier */
  udid: string;
  /** Numeric device ID */
  deviceId: number;
  /** IP address of the tunnel */
  address: string;
  /** Remote Service Discovery (RSD) port number */
  rsdPort: number;
  /** Optional packet stream port number */
  packetStreamPort?: number;
  /** Type of connection (e.g., 'USB', 'Network') */
  connectionType: string;
  /** Product identifier of the device */
  productId: number;
  /** Timestamp when the tunnel was created (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when the tunnel was last updated (milliseconds since epoch) */
  lastUpdated: number;
}

export interface TunnelRegistry {
  /** Map of UDID to tunnel registry entries */
  tunnels: Record<string, TunnelRegistryEntry>;
  /** Metadata about the registry */
  metadata: {
    /** ISO 8601 timestamp of last registry update */
    lastUpdated: string;
    /** Total number of tunnels in the registry */
    totalTunnels: number;
    /** Number of currently active tunnels */
    activeTunnels: number;
  };
}

export interface SocketInfo {
  /** Device server information */
  server: Device;
  /** Port number for the socket connection */
  port: number;
  /** Device-specific information */
  deviceInfo: {
    /** Unique device identifier */
    udid: string;
    /** IP address of the device */
    address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    rsdPort?: number;
  };
}

export interface TunnelResult {
  /** Device information */
  device: Device;
  /** Tunnel connection details */
  tunnel: {
    /** IP address of the tunnel */
    Address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    RsdPort?: number;
  };
  /** Optional packet stream port number */
  packetStreamPort?: number;
  /** Indicates whether the tunnel creation was successful */
  success: boolean;
  /** Error message if tunnel creation failed */
  error?: string;
}
