import { logger } from '@appium/support';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import type { AppleTVDevice } from '../../bonjour/bonjour-discovery.js';
import {
  DEFAULT_PAIRING_CONFIG,
  PairingDataComponentType,
} from '../constants.js';
import { encodeAppleTVDeviceInfo } from '../deviceInfo/index.js';
import {
  createEd25519Signature,
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
  generateEd25519KeyPair,
  hkdf,
} from '../encryption/index.js';
import { PairingError } from '../errors.js';
import { NETWORK_CONSTANTS } from '../network/constants.js';
import type { NetworkClientInterface } from '../network/types.js';
import { SRPClient } from '../srp/index.js';
import { PairingStorage } from '../storage/pairing-storage.js';
import {
  createPairVerificationData,
  createSetupManualPairingData,
  decodeTLV8ToDict,
  encodeTLV8,
} from '../tlv/index.js';
import type { TLV8Item } from '../types.js';
import { generateHostId } from '../utils/uuid-generator.js';
import { INFO_TYPE, PAIRING_MESSAGES, PAIRING_STATES } from './constants.js';
import type {
  EncryptionKeys,
  PairingProtocolInterface,
  PairingRequest,
  UserInputInterface,
} from './types.js';

/** Implements the Apple TV pairing protocol including SRP authentication and key exchange */
export class PairingProtocol implements PairingProtocolInterface {
  private static readonly log = logger.getLogger('PairingProtocol');
  private _sequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly userInput: UserInputInterface,
  ) {}

  async executePairingFlow(device: AppleTVDevice): Promise<string> {
    this._sequenceNumber = 1;

    try {
      // Step 1: Handshake
      await this.performHandshake();

      // Step 2: Pair verification attempt
      await this.attemptPairVerification();

      // Step 3: Setup manual pairing
      const setupResponse = await this.setupManualPairing();
      const srpData = this.extractAndValidatePairingData(setupResponse);

      // Step 4: SRP Authentication
      const srpClient = await this.performSRPAuthentication(srpData);

      // Step 5: Generate keys and send M5
      const encryptionKeys = this.deriveEncryptionKeys(srpClient.sessionKey);
      const { publicKey: ltpk, privateKey: ltsk } = generateEd25519KeyPair();
      const devicePairingID = generateHostId(hostname());

      await this.sendM5Message(
        encryptionKeys.encryptKey,
        devicePairingID,
        ltpk,
        ltsk,
        srpClient.sessionKey,
      );

      // Step 6: Receive M6 completion
      await this.receiveM6Completion(encryptionKeys.decryptKey);

      return this.createPairingResult(device, ltpk, ltsk);
    } catch (error) {
      PairingProtocol.log.error('Pairing flow failed:', error);
      throw error;
    }
  }

  private createRequest(content: any, sequenceNumber?: number): PairingRequest {
    return {
      message: {
        plain: {
          _0: content,
        },
      },
      originatedBy: 'host',
      sequenceNumber: sequenceNumber ?? this._sequenceNumber++,
    };
  }

  /**
   * Fragments a buffer into TLV8 items of maximum fragment size
   * @param buffer Buffer to fragment
   * @param type TLV8 type identifier
   * @returns Array of TLV8 items
   */
  private fragmentBuffer(buffer: Buffer, type: number): TLV8Item[] {
    const fragments: TLV8Item[] = [];
    for (
      let i = 0;
      i < buffer.length;
      i += NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE
    ) {
      fragments.push({
        type,
        data: buffer.subarray(i, i + NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE),
      });
    }
    return fragments;
  }

  /**
   * Creates a nonce buffer with prefix padding
   * @param nonceString The nonce string identifier
   * @returns Padded nonce buffer
   */
  private createNonce(nonceString: string): Buffer {
    return Buffer.concat([Buffer.alloc(4), Buffer.from(nonceString)]);
  }

  /**
   * Performs initial handshake with Apple TV to establish connection
   * Sends handshake request with host options and wire protocol version
   */
  private async performHandshake(): Promise<void> {
    const request = this.createHandshakeRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();
    PairingProtocol.log.debug('Handshake completed');
  }

  /**
   * Attempts to verify existing pairing credentials with Apple TV
   * Creates pair verification request and handles expected failure for new pairing flow
   */
  private async attemptPairVerification(): Promise<void> {
    const request = this.createPairVerificationRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();

    const failedRequest = this.createPairVerifyFailedRequest();
    await this.networkClient.sendPacket(failedRequest);
    PairingProtocol.log.debug('Pair verification attempt completed');
  }

  /**
   * Initiates manual pairing setup process with Apple TV
   * Sends setup request and receives SRP challenge data
   * @returns Response containing SRP salt and server public key
   */
  private async setupManualPairing(): Promise<any> {
    const request = this.createSetupManualPairingRequest();
    await this.networkClient.sendPacket(request);
    const response = await this.networkClient.receiveResponse();
    PairingProtocol.log.debug('Manual pairing setup completed');
    return response;
  }

  /**
   * Extracts and validates SRP pairing data from Apple TV response
   * @param response Network response containing pairing data
   * @returns Parsed TLV8 dictionary with SRP challenge components
   * @throws PairingError if pairing data is missing or invalid
   */
  private extractAndValidatePairingData(response: any): Record<number, Buffer> {
    const srpData =
      response.message?.plain?._0?.event?._0?.pairingData?._0?.data;
    if (!srpData) {
      throw new PairingError('No pairing data received', 'NO_PAIRING_DATA');
    }

    const parsedSRP = this.parseTLV8Response(srpData);
    this.validateSRPResponse(parsedSRP);
    return parsedSRP;
  }

  /**
   * Performs SRP authentication using user-provided PIN
   * Prompts for PIN, creates SRP client, sends proof, and validates response
   * @param parsedSRP SRP challenge data from Apple TV
   * @returns Authenticated SRP client with session key
   * @throws PairingError if PIN is incorrect or authentication fails
   */
  private async performSRPAuthentication(
    parsedSRP: Record<number, Buffer>,
  ): Promise<SRPClient> {
    const pin = await this.userInput.promptForPIN();
    const srpClient = this.createSRPClient(pin, parsedSRP);

    await this.sendSRPProof(srpClient);
    const response = await this.networkClient.receiveResponse();
    this.validateSRPProofResponse(response);

    PairingProtocol.log.debug('SRP authentication completed');
    return srpClient;
  }

  /**
   * Receives and processes M6 pairing completion message from Apple TV
   * Attempts to decrypt and validate final pairing state
   * @param decryptKey Decryption key for M6 encrypted data
   */
  private async receiveM6Completion(decryptKey: Buffer): Promise<void> {
    const m6Response = await this.networkClient.receiveResponse();
    PairingProtocol.log.info('M6 Response received');

    try {
      this.processM6Response(m6Response, decryptKey);
    } catch (error) {
      PairingProtocol.log.warn(
        'M6 decryption failed - but pairing may still be successful:',
        (error as Error).message,
      );
    }
  }

  /**
   * Constructs initial handshake request packet
   * Includes host options and wire protocol version for pairing session
   * @returns Handshake request with sequence number 0
   */
  private createHandshakeRequest(): PairingRequest {
    return {
      message: {
        plain: {
          _0: {
            request: {
              _0: {
                handshake: {
                  _0: {
                    hostOptions: { attemptPairVerify: true },
                    wireProtocolVersion: 19,
                  },
                },
              },
            },
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: 0,
    };
  }

  /**
   * Creates pair verification request with X25519 public key
   * Used to attempt verification of existing pairing credentials
   * @returns Pair verification request with random X25519 key
   */
  private createPairVerificationRequest(): PairingRequest {
    const x25519PublicKey = randomBytes(32);
    const pairingData = createPairVerificationData(x25519PublicKey);

    return this.createRequest({
      event: {
        _0: {
          pairingData: {
            _0: {
              data: pairingData,
              kind: 'verifyManualPairing',
              startNewSession: true,
            },
          },
        },
      },
    });
  }

  /**
   * Creates pair verification failed event request
   * Sent after verification attempt to proceed with manual pairing setup
   * @returns Pair verify failed event packet
   */
  private createPairVerifyFailedRequest(): PairingRequest {
    return this.createRequest({
      event: {
        _0: {
          pairVerifyFailed: {},
        },
      },
    });
  }

  /**
   * Constructs manual pairing setup request packet
   * Initiates M1/M2 exchange with setup pairing data
   * @returns Setup manual pairing request with host information
   */
  private createSetupManualPairingRequest(): PairingRequest {
    const setupData = createSetupManualPairingData();

    return this.createRequest({
      event: {
        _0: {
          pairingData: {
            _0: {
              data: setupData,
              kind: 'setupManualPairing',
              sendingHost: hostname(),
              startNewSession: true,
            },
          },
        },
      },
    });
  }

  /**
   * Parses base64-encoded TLV8 response into dictionary
   * Decodes base64 string and converts TLV8 format to key-value pairs
   * @param data Base64-encoded TLV8 data
   * @returns Dictionary mapping TLV8 type numbers to buffer values
   * @throws PairingError if TLV8 parsing fails
   */
  private parseTLV8Response(data: string): Record<number, Buffer> {
    try {
      const buffer = Buffer.from(data, 'base64');
      const decoded = decodeTLV8ToDict(buffer);

      const result: Record<number, Buffer> = {};
      for (const [key, value] of Object.entries(decoded)) {
        if (value !== undefined) {
          result[Number(key)] = value;
        }
      }
      return result;
    } catch (error) {
      throw new PairingError(
        'Failed to parse TLV8 response',
        'TLV8_PARSE_ERROR',
        error,
      );
    }
  }

  /**
   * Validates SRP response for errors and required challenge data
   * Checks for error codes and verifies presence of salt and public key
   * @param parsedSRP Parsed SRP response dictionary
   * @throws PairingError if response contains errors or missing required data
   */
  private validateSRPResponse(parsedSRP: Record<number, Buffer>): void {
    const errorBuffer = parsedSRP[PairingDataComponentType.ERROR];
    if (errorBuffer) {
      if (errorBuffer.length === 0) {
        throw new PairingError(
          'Apple TV returned empty error buffer',
          'INVALID_ERROR_RESPONSE',
        );
      }
      const errorCode = errorBuffer[0];
      throw new PairingError(
        `Apple TV rejected request with error ${errorCode}`,
        'APPLE_TV_ERROR',
        { errorCode },
      );
    }

    if (
      !parsedSRP[PairingDataComponentType.SALT] ||
      !parsedSRP[PairingDataComponentType.PUBLIC_KEY]
    ) {
      throw new PairingError('Missing SRP challenge data', 'MISSING_SRP_DATA');
    }
  }

  /**
   * Initializes SRP client with PIN and server challenge data
   * Sets up identity, salt, and server public key for proof computation
   * @param pin User-provided pairing PIN
   * @param parsedSRP SRP challenge data containing salt and server public key
   * @returns Configured SRP client ready for proof generation
   * @throws PairingError if required SRP data is missing
   */
  private createSRPClient(
    pin: string,
    parsedSRP: Record<number, Buffer>,
  ): SRPClient {
    try {
      const salt = parsedSRP[PairingDataComponentType.SALT];
      const serverPublicKey = parsedSRP[PairingDataComponentType.PUBLIC_KEY];

      const srpClient = new SRPClient();
      srpClient.setIdentity('Pair-Setup', pin);
      srpClient.salt = salt;
      srpClient.serverPublicKey = serverPublicKey;
      return srpClient;
    } catch (error) {
      throw new PairingError(
        'Failed to create SRP client',
        'SRP_CLIENT_ERROR',
        error,
      );
    }
  }

  /**
   * Sends M3 message containing SRP proof to Apple TV
   * Includes client public key and computed proof for authentication
   * @param srpClient Configured SRP client with computed proof
   */
  private async sendSRPProof(srpClient: SRPClient): Promise<void> {
    const clientPublicKey = srpClient.publicKey;
    const clientProof = srpClient.computeProof();

    const tlvItems: TLV8Item[] = [
      {
        type: PairingDataComponentType.STATE,
        data: Buffer.from([PAIRING_STATES.M3]),
      },
      ...this.fragmentBuffer(
        clientPublicKey,
        PairingDataComponentType.PUBLIC_KEY,
      ),
      { type: PairingDataComponentType.PROOF, data: clientProof },
    ];
    const tlv = encodeTLV8(tlvItems);

    const request = this.createRequest({
      event: {
        _0: {
          pairingData: {
            _0: {
              data: tlv.toString('base64'),
              kind: 'setupManualPairing',
              sendingHost: hostname(),
              startNewSession: false,
            },
          },
        },
      },
    });

    await this.networkClient.sendPacket(request);
  }

  /**
   * Validates M4 SRP proof response from Apple TV
   * Checks for authentication errors indicating incorrect PIN
   * @param response Network response containing SRP proof validation result
   * @throws PairingError if PIN authentication failed
   */
  private validateSRPProofResponse(response: any): void {
    if (response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      const proofData = Buffer.from(
        response.message.plain._0.event._0.pairingData._0.data,
        'base64',
      );
      const parsedProof = decodeTLV8ToDict(proofData);

      if (parsedProof[PairingDataComponentType.ERROR]) {
        throw new PairingError(
          'SRP authentication failed - wrong PIN',
          'WRONG_PIN',
        );
      }
    }
  }

  /**
   * Sends M5 exchange message with encrypted pairing credentials
   * Includes long-term public key, signature, and device information encrypted with session key
   * @param encryptKey Encryption key derived from session key
   * @param devicePairingID Host device pairing identifier
   * @param ltpk Long-term public key (Ed25519)
   * @param ltsk Long-term secret key (Ed25519)
   * @param sessionKey SRP session key for signature derivation
   * @throws PairingError if M5 message creation fails
   */
  private async sendM5Message(
    encryptKey: Buffer,
    devicePairingID: string,
    ltpk: Buffer,
    ltsk: Buffer,
    sessionKey: Buffer,
  ): Promise<void> {
    try {
      const signingKey = hkdf({
        ikm: sessionKey,
        salt: Buffer.from(PAIRING_MESSAGES.SIGN_SALT, 'utf8'),
        info: Buffer.from(PAIRING_MESSAGES.SIGN_INFO, 'utf8'),
        length: 32,
      });

      const devicePairingIDBuffer = Buffer.from(devicePairingID, 'utf8');
      const dataToSign = Buffer.concat([
        signingKey,
        devicePairingIDBuffer,
        ltpk,
      ]);
      const signature = createEd25519Signature(dataToSign, ltsk);
      const deviceInfo = encodeAppleTVDeviceInfo(devicePairingID);

      const tlvItems: TLV8Item[] = [
        {
          type: PairingDataComponentType.IDENTIFIER,
          data: devicePairingIDBuffer,
        },
        { type: PairingDataComponentType.PUBLIC_KEY, data: ltpk },
        { type: PairingDataComponentType.SIGNATURE, data: signature },
        { type: INFO_TYPE as any, data: deviceInfo },
      ];

      const tlvData = encodeTLV8(tlvItems);
      const nonce = this.createNonce(PAIRING_MESSAGES.M5_NONCE);
      const encrypted = encryptChaCha20Poly1305({
        plaintext: tlvData,
        key: encryptKey,
        nonce,
      });

      const encryptedTLVItems: TLV8Item[] = [
        ...this.fragmentBuffer(
          encrypted,
          PairingDataComponentType.ENCRYPTED_DATA,
        ),
        {
          type: PairingDataComponentType.STATE,
          data: Buffer.from([PAIRING_STATES.M5]),
        },
      ];
      const encryptedTLV = encodeTLV8(encryptedTLVItems);

      const request = this.createRequest({
        event: {
          _0: {
            pairingData: {
              _0: {
                data: encryptedTLV.toString('base64'),
                kind: 'setupManualPairing',
                sendingHost: hostname(),
                startNewSession: false,
              },
            },
          },
        },
      });

      await this.networkClient.sendPacket(request);
    } catch (error) {
      throw new PairingError('Failed to create M5 message', 'M5_ERROR', error);
    }
  }

  /**
   * Processes and decrypts M6 completion response from Apple TV
   * Validates pairing completion state and decrypts final exchange data
   * @param m6Response Network response containing M6 completion message
   * @param decryptKey Decryption key for M6 encrypted data
   */
  private processM6Response(m6Response: any, decryptKey: Buffer): void {
    if (!m6Response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      return;
    }

    const m6DataBase64 =
      m6Response.message.plain._0.event._0.pairingData._0.data;
    const m6TLVBuffer = Buffer.from(m6DataBase64, 'base64');
    const m6Parsed = decodeTLV8ToDict(m6TLVBuffer);

    PairingProtocol.log.debug(
      'M6 TLV types received:',
      Object.keys(m6Parsed).map((k) => `0x${Number(k).toString(16)}`),
    );

    const stateData = m6Parsed[PairingDataComponentType.STATE];
    if (stateData && stateData[0] === PAIRING_STATES.M6) {
      PairingProtocol.log.info(
        '✅ Pairing completed successfully (STATE=0x06)',
      );
    }

    const encryptedData = m6Parsed[PairingDataComponentType.ENCRYPTED_DATA];
    if (encryptedData) {
      const nonce = this.createNonce(PAIRING_MESSAGES.M6_NONCE);
      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encryptedData,
        key: decryptKey,
        nonce,
      });
      const decryptedTLV = decodeTLV8ToDict(decrypted);
      PairingProtocol.log.debug(
        'M6 decrypted content types:',
        Object.keys(decryptedTLV),
      );
    }
  }

  /**
   * Derives encryption and decryption keys from SRP session key
   * Uses HKDF with pairing-specific salt and info strings
   * @param sessionKey SRP session key from authentication
   * @returns Encryption keys for M5/M6 message exchange
   */
  private deriveEncryptionKeys(sessionKey: Buffer): EncryptionKeys {
    const sharedKey = hkdf({
      ikm: sessionKey,
      salt: Buffer.from(PAIRING_MESSAGES.ENCRYPT_SALT, 'utf8'),
      info: Buffer.from(PAIRING_MESSAGES.ENCRYPT_INFO, 'utf8'),
      length: 32,
    });

    PairingProtocol.log.debug('Derived encryption keys');
    return {
      encryptKey: sharedKey,
      decryptKey: sharedKey,
    };
  }

  /**
   * Saves pairing credentials to storage and returns credential path
   * Persists long-term public and private keys for future connections
   * @param device Apple TV device information
   * @param ltpk Long-term public key to save
   * @param ltsk Long-term secret key to save
   * @returns Path to saved pairing credentials file
   */
  private async createPairingResult(
    device: AppleTVDevice,
    ltpk: Buffer,
    ltsk: Buffer,
  ): Promise<string> {
    const storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
    return await storage.save(device.identifier || device.name, ltpk, ltsk);
  }
}
