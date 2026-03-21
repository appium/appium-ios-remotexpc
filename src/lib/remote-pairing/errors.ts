// Base error class for Remote Pairing (Wi‑Fi HAP-style) flows
export class RemotePairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Represents an error that occurs during the pairing process
export class PairingError extends RemotePairingError {
  constructor(
    message: string,
    public code?: string,
    public details?: any,
  ) {
    super(message);
  }
}

/** Raised when the user taps Don't Trust or pairing is rejected on the device */
export class UserDeniedPairingError extends PairingError {
  constructor(message: string, details?: any) {
    super(message, 'USER_DENIED_PAIRING', details);
  }
}

/**
 * Mirrors pymobiledevice3's RemotePairingCompletedError: the peer closed the
 * connection after pairing finished; reconnect to continue (e.g. tunnel).
 */
export class RemotePairingCompletedError extends PairingError {
  constructor(
    message = 'Remote pairing completed; connection closed by peer',
    public readonly pairingFilePath?: string,
  ) {
    super(message, 'REMOTE_PAIRING_COMPLETED');
  }
}

// Represents an error related to network communication
export class NetworkError extends RemotePairingError {}

// Represents an error occurring during cryptographic operations
export class CryptographyError extends RemotePairingError {}

// Represents an error specific to SRP (Secure Remote Password) protocol
export class SRPError extends RemotePairingError {}

// Represents an error related to TLV8 encoding/decoding
export class TLV8Error extends RemotePairingError {}
