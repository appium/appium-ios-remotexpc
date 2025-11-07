import type { AppleTVDevice } from '../../bonjour/bonjour-discovery.js';

/** Encryption keys derived from SRP session key for secure communication */
export interface EncryptionKeys {
  encryptKey: Buffer;
  decryptKey: Buffer;
}

/** Handshake message payload structure */
export interface HandshakePayload {
  request: {
    _0: {
      handshake: {
        _0: {
          hostOptions: { attemptPairVerify: boolean };
          wireProtocolVersion: number;
        };
      };
    };
  };
}

/** Pairing event message payload structure */
export interface PairingDataPayload {
  event: {
    _0: {
      pairingData?: {
        _0: {
          data: string;
          kind: 'verifyManualPairing' | 'setupManualPairing';
          startNewSession?: boolean;
          sendingHost?: string;
        };
      };
      pairVerifyFailed?: Record<string, never>;
    };
  };
}

/** Structure of a pairing request message sent to Apple TV */
export interface PairingRequest {
  message: {
    plain: {
      _0: HandshakePayload | PairingDataPayload;
    };
  };
  originatedBy: 'host' | 'accessory';
  sequenceNumber: number;
}

/** Interface for handling user input during pairing process */
export interface UserInputInterface {
  promptForPIN(): Promise<string>;
  promptForInput(prompt: string): Promise<string>;
}

/** Interface for executing the Apple TV pairing protocol flow */
export interface PairingProtocolInterface {
  executePairingFlow(device: AppleTVDevice): Promise<string>;
}
