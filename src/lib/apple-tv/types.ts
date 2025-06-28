// Represents detailed information about an Apple TV device
export interface AppleTVDeviceInfo {
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

// Configuration options for the pairing process
export interface PairingConfig {
  timeout: number;
  discoveryTimeout: number;
  maxRetries: number;
  pairingDirectory: string;
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
