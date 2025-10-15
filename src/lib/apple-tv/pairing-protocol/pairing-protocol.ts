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
  private readonly log = logger.getLogger('PairingProtocol');
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
      this.log.error('Pairing flow failed:', error);
      throw error;
    }
  }

  private async performHandshake(): Promise<void> {
    const request = this.createHandshakeRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();
    this.log.debug('Handshake completed');
  }

  private async attemptPairVerification(): Promise<void> {
    const request = this.createPairVerificationRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();

    const failedRequest = this.createPairVerifyFailedRequest();
    await this.networkClient.sendPacket(failedRequest);
    this.log.debug('Pair verification attempt completed');
  }

  private async setupManualPairing(): Promise<any> {
    const request = this.createSetupManualPairingRequest();
    await this.networkClient.sendPacket(request);
    const response = await this.networkClient.receiveResponse();
    this.log.debug('Manual pairing setup completed');
    return response;
  }

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

  private async performSRPAuthentication(
    parsedSRP: Record<number, Buffer>,
  ): Promise<SRPClient> {
    const pin = await this.userInput.promptForPIN();
    const srpClient = this.createSRPClient(pin, parsedSRP);

    await this.sendSRPProof(srpClient);
    const response = await this.networkClient.receiveResponse();
    this.validateSRPProofResponse(response);

    this.log.debug('SRP authentication completed');
    return srpClient;
  }

  private async receiveM6Completion(decryptKey: Buffer): Promise<void> {
    const m6Response = await this.networkClient.receiveResponse();
    this.log.info('M6 Response received');

    try {
      this.processM6Response(m6Response, decryptKey);
    } catch (error) {
      this.log.warn(
        'M6 decryption failed - but pairing may still be successful:',
        (error as Error).message,
      );
    }
  }

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

  private createPairVerificationRequest(): PairingRequest {
    const x25519PublicKey = randomBytes(32);
    const pairingData = createPairVerificationData(x25519PublicKey);

    return {
      message: {
        plain: {
          _0: {
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
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    };
  }

  private createPairVerifyFailedRequest(): PairingRequest {
    return {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairVerifyFailed: {},
              },
            },
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    };
  }

  private createSetupManualPairingRequest(): PairingRequest {
    const setupData = createSetupManualPairingData();

    return {
      message: {
        plain: {
          _0: {
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
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    };
  }

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

  private createSRPClient(
    pin: string,
    parsedSRP: Record<number, Buffer>,
  ): SRPClient {
    try {
      const salt = parsedSRP[PairingDataComponentType.SALT];
      const serverPublicKey = parsedSRP[PairingDataComponentType.PUBLIC_KEY];

      if (!salt || !serverPublicKey) {
        throw new PairingError('Missing required SRP data', 'MISSING_SRP_DATA');
      }

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

  private async sendSRPProof(srpClient: SRPClient): Promise<void> {
    const clientPublicKey = srpClient.publicKey;
    const clientProof = srpClient.computeProof();

    const tlvItems: TLV8Item[] = [
      {
        type: PairingDataComponentType.STATE,
        data: Buffer.from([PAIRING_STATES.M3]),
      },
    ];

    // Fragment public key if necessary
    for (
      let i = 0;
      i < clientPublicKey.length;
      i += NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE
    ) {
      const fragment = clientPublicKey.slice(
        i,
        i + NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE,
      );
      tlvItems.push({
        type: PairingDataComponentType.PUBLIC_KEY,
        data: fragment,
      });
    }

    tlvItems.push({ type: PairingDataComponentType.PROOF, data: clientProof });
    const tlv = encodeTLV8(tlvItems);

    const request: PairingRequest = {
      message: {
        plain: {
          _0: {
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
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    };

    await this.networkClient.sendPacket(request);
  }

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
      const nonce = Buffer.concat([
        Buffer.alloc(4),
        Buffer.from(PAIRING_MESSAGES.M5_NONCE),
      ]);
      const encrypted = encryptChaCha20Poly1305({
        plaintext: tlvData,
        key: encryptKey,
        nonce,
      });

      const encryptedTLVItems: TLV8Item[] = [];
      for (
        let i = 0;
        i < encrypted.length;
        i += NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE
      ) {
        const fragment = encrypted.slice(
          i,
          Math.min(
            i + NETWORK_CONSTANTS.MAX_TLV_FRAGMENT_SIZE,
            encrypted.length,
          ),
        );
        encryptedTLVItems.push({
          type: PairingDataComponentType.ENCRYPTED_DATA,
          data: fragment,
        });
      }

      encryptedTLVItems.push({
        type: PairingDataComponentType.STATE,
        data: Buffer.from([PAIRING_STATES.M5]),
      });
      const encryptedTLV = encodeTLV8(encryptedTLVItems);

      const request: PairingRequest = {
        message: {
          plain: {
            _0: {
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
            },
          },
        },
        originatedBy: 'host',
        sequenceNumber: this._sequenceNumber++,
      };

      await this.networkClient.sendPacket(request);
    } catch (error) {
      throw new PairingError('Failed to create M5 message', 'M5_ERROR', error);
    }
  }

  private processM6Response(m6Response: any, decryptKey: Buffer): void {
    if (!m6Response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      return;
    }

    const m6DataBase64 =
      m6Response.message.plain._0.event._0.pairingData._0.data;
    const m6TLVBuffer = Buffer.from(m6DataBase64, 'base64');
    const m6Parsed = decodeTLV8ToDict(m6TLVBuffer);

    this.log.debug(
      'M6 TLV types received:',
      Object.keys(m6Parsed).map((k) => `0x${Number(k).toString(16)}`),
    );

    const stateData = m6Parsed[PairingDataComponentType.STATE];
    if (stateData && stateData[0] === PAIRING_STATES.M6) {
      this.log.info('✅ Pairing completed successfully (STATE=0x06)');
    }

    const encryptedData = m6Parsed[PairingDataComponentType.ENCRYPTED_DATA];
    if (encryptedData) {
      const nonce = Buffer.concat([
        Buffer.alloc(4),
        Buffer.from(PAIRING_MESSAGES.M6_NONCE),
      ]);
      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encryptedData,
        key: decryptKey,
        nonce,
      });
      const decryptedTLV = decodeTLV8ToDict(decrypted);
      this.log.debug('M6 decrypted content types:', Object.keys(decryptedTLV));
    }
  }

  private deriveEncryptionKeys(sessionKey: Buffer): EncryptionKeys {
    const sharedKey = hkdf({
      ikm: sessionKey,
      salt: Buffer.from(PAIRING_MESSAGES.ENCRYPT_SALT, 'utf8'),
      info: Buffer.from(PAIRING_MESSAGES.ENCRYPT_INFO, 'utf8'),
      length: 32,
    });

    this.log.debug('Derived encryption keys');
    return {
      encryptKey: sharedKey,
      decryptKey: sharedKey,
    };
  }

  private createPairingResult(
    device: AppleTVDevice,
    ltpk: Buffer,
    ltsk: Buffer,
  ): string {
    const storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
    return storage.save(device.identifier || device.name, ltpk, ltsk);
  }
}
