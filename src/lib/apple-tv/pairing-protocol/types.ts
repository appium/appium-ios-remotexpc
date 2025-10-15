import type { AppleTVDevice } from '../../bonjour/bonjour-discovery.js';

/** Encryption keys derived from SRP session key for secure communication */
export interface EncryptionKeys {
  encryptKey: Buffer;
  decryptKey: Buffer;
}

/** Structure of a pairing request message sent to Apple TV */
export interface PairingRequest {
  message: {
    plain: {
      _0: any;
    };
  };
  originatedBy: string;
  sequenceNumber: number;
}

/** Interface for handling user input during pairing process */
export interface UserInputInterface {
  promptForPIN(): Promise<string>;
}

/** Interface for executing the Apple TV pairing protocol flow */
export interface PairingProtocolInterface {
  executePairingFlow(device: AppleTVDevice): Promise<string>;
}
