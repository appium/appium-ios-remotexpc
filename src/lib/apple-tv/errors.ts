// Base error class for all Apple TV related errors
export class AppleTVError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Represents an error that occurs during the pairing process
export class PairingError extends AppleTVError {
  constructor(
    message: string,
    public code?: string,
    public details?: any,
  ) {
    super(message);
  }
}

// Represents an error related to network communication
export class NetworkError extends AppleTVError {
  constructor(message: string) {
    super(message);
  }
}

// Represents an error occurring during cryptographic operations
export class CryptographyError extends AppleTVError {
  constructor(message: string) {
    super(message);
  }
}

// Represents an error specific to SRP (Secure Remote Password) protocol
export class SRPError extends AppleTVError {
  constructor(message: string) {
    super(message);
  }
}

// Represents an error related to TLV8 encoding/decoding
export class TLV8Error extends AppleTVError {
  constructor(message: string) {
    super(message);
  }
}
