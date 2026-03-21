// Controller identity blob embedded in Pair-Setup M5 (OPACK device info)
export interface RemotePairingDeviceInfo {
  altIRK: Buffer;
  btAddr: string;
  mac: Buffer;
  remotePairingSerialNumber: string;
  accountID: string;
  model: string;
  name: string;
}

// Represents a key pair used during pairing (public/private keys)
export interface PairingKeys {
  publicKey: Buffer;
  privateKey: Buffer;
}

// Represents the result of a pairing attempt
export interface PairingResult {
  success: boolean;
  pairingFile?: string;
  deviceId: string;
  error?: Error;
}

/** Result of {@link RemotePairingService.discoverAndPair}. */
export type RemotePairingResult = PairingResult;

// Discovered `_remotepairing._tcp` target for pairing / tunnel flows
export interface RemotePairingDevice {
  name: string;
  identifier: string;
  hostname: string;
  ip?: string;
  port: number;
  model: string;
  version: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  minVersion: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  authTag?: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  interfaceIndex?: number;
}

// Configuration options for the pairing process
export interface PairingConfig {
  timeout: number;
  discoveryTimeout: number;
  maxRetries: number;
}

// Represents a TLV8 data item with a type and binary data
export interface TLV8Item {
  type: PairingDataComponentTypeValue;
  data: Buffer;
}

// Type alias for TLV8 component type values
export type PairingDataComponentTypeValue = number;

// Represents any valid Opack2 data type
export type Opack2Value =
  | null
  | undefined
  | boolean
  | number
  | string
  | Buffer
  | Opack2Array
  | Opack2Dictionary;

// Represents an array of Opack2 values
export interface Opack2Array extends Array<Opack2Value> {}

// Represents a dictionary of Opack2 values
export interface Opack2Dictionary extends Record<string, Opack2Value> {}
