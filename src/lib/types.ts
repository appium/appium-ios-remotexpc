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

export interface TunnelRegistry {
  tunnels: Record<string, TunnelRegistryEntry>;
  metadata: {
    lastUpdated: number;
    totalTunnels: number;
    activeTunnels: number;
  };
}

export interface SocketInfo {
  server: Device;
  port: number;
  deviceInfo: {
    udid: string;
    address: string;
    rsdPort?: number;
  };
}

export interface TunnelResult {
  device: Device;
  tunnel: {
    Address: string;
    RsdPort?: number;
  };
  packetStreamPort?: number;
  success: boolean;
  error?: string;
}
