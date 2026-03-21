import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { getLogger } from '../../logger.js';
import {
  DEFAULT_PAIRING_CONFIG,
  PairingDataComponentType,
} from '../constants.js';
import { encodePairingControllerDeviceInfo } from '../deviceInfo/index.js';
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
import type { RemotePairingDevice, TLV8Item } from '../types.js';
import { generateHostId } from '../utils/uuid-generator.js';
import {
  ENCRYPTION_MESSAGES,
  INFO_TYPE,
  PAIRING_MESSAGES,
  PAIRING_STATES,
} from './constants.js';
import { PairVerificationProtocol } from './pair-verification-protocol.js';
import { resolvePairingDataFieldAfterM1 } from './pairing-consent.js';
import type {
  EncryptionKeys,
  PairingProtocolInterface,
  PairingRequest,
  UserInputInterface,
} from './types.js';

const log = getLogger('PairingProtocol');

/** From handshake response; used for PIN policy (pymobiledevice3: Apple TV vs iOS). */
export interface PeerDeviceInfo {
  identifier: string;
  model: string;
}

export function isAppleTvModel(model?: string): boolean {
  return Boolean(model && model.includes('AppleTV'));
}

/**
 * Remote Pairing Pair-Setup (HAP-style), aligned with pymobiledevice3 RemotePairingProtocol.
 */
export class PairingProtocol implements PairingProtocolInterface {
  private _sequenceNumber = 0;
  private peerDeviceInfo?: PeerDeviceInfo;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly userInput: UserInputInterface,
  ) {}

  async executePairingFlow(device: RemotePairingDevice): Promise<string> {
    this._sequenceNumber = 1;
    this.peerDeviceInfo = undefined;

    await this.performHandshake();

    const storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
    const deviceId = this.getStableDeviceId(device);

    const existing = await storage.load(deviceId);
    if (existing) {
      const verifier = new PairVerificationProtocol(this.networkClient);
      verifier.setSequenceNumber(this._sequenceNumber);
      try {
        await verifier.verify(existing, deviceId);
        this._sequenceNumber = verifier.getSequenceNumber();
        const path = await storage.getPairingRecordPath(deviceId);
        log.info(
          `Already paired with ${deviceId}; pair verification succeeded`,
        );
        if (path) {
          return path;
        }
        return `paired:${deviceId}`;
      } catch (e) {
        log.debug(
          'Existing pair record did not verify; continuing with manual pairing',
          e,
        );
      }
    }

    await this.attemptPairVerification();
    const setupResponse = await this.setupManualPairing();
    const srpData = await this.extractPairingDataAfterConsent(setupResponse);

    const srpClient = await this.performSRPAuthentication(srpData);

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

    await this.receiveM6Completion(encryptionKeys.decryptKey);

    let remoteUnlockHostKey = '';
    try {
      remoteUnlockHostKey = await this.createRemoteUnlockKey(
        srpClient.sessionKey,
      );
    } catch (e) {
      log.debug(
        'createRemoteUnlockKey not supported or failed (expected on tvOS)',
        e,
      );
    }

    return await this.createPairingResult(
      deviceId,
      ltpk,
      ltsk,
      remoteUnlockHostKey,
      storage,
    );
  }

  private getStableDeviceId(device: RemotePairingDevice): string {
    return this.peerDeviceInfo?.identifier || device.identifier || device.name;
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

  private createNonce(nonceString: string): Buffer {
    return Buffer.concat([Buffer.alloc(4), Buffer.from(nonceString)]);
  }

  private async performHandshake(): Promise<void> {
    const request = this.createHandshakeRequest();
    await this.networkClient.sendPacket(request);
    const response = await this.networkClient.receiveResponse();
    this.parseHandshakeResponse(response);
    log.debug('Handshake completed');
  }

  private parseHandshakeResponse(response: any): void {
    const h = response?.message?.plain?._0?.response?._1?.handshake?._0;
    if (h?.peerDeviceInfo) {
      this.peerDeviceInfo = {
        identifier: String(h.peerDeviceInfo.identifier ?? ''),
        model: String(h.peerDeviceInfo.model ?? ''),
      };
      log.debug(
        `Handshake peerDeviceInfo: ${this.peerDeviceInfo.identifier} (${this.peerDeviceInfo.model})`,
      );
    }
  }

  private async attemptPairVerification(): Promise<void> {
    const request = this.createPairVerificationRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();

    const failedRequest = this.createPairVerifyFailedRequest();
    await this.networkClient.sendPacket(failedRequest);
    log.debug('Pair verification attempt completed');
  }

  private async setupManualPairing(): Promise<any> {
    const request = this.createSetupManualPairingRequest();
    await this.networkClient.sendPacket(request);
    const response = await this.networkClient.receiveResponse();
    log.debug('Manual pairing setup (M1) response received');
    return response;
  }

  /**
   * pymobiledevice3 _request_pair_consent: immediate pairingData, awaitingUserConsent, or rejection.
   */
  private async extractPairingDataAfterConsent(
    firstResponse: any,
  ): Promise<Record<number, Buffer>> {
    const rawData = await resolvePairingDataFieldAfterM1(
      firstResponse,
      async () => {
        log.info(
          'Waiting for user consent (Trust This Computer) on the device…',
        );
        return await this.networkClient.receiveResponse();
      },
    );

    const srpDataStr =
      typeof rawData === 'string'
        ? rawData
        : Buffer.from(rawData).toString('base64');

    const parsedSRP = this.parseTLV8Response(srpDataStr);
    this.validateSRPResponse(parsedSRP);
    return parsedSRP;
  }

  private async performSRPAuthentication(
    parsedSRP: Record<number, Buffer>,
  ): Promise<SRPClient> {
    const pin = await this.resolveSrpPassword();
    const srpClient = this.createSRPClient(pin, parsedSRP);

    await this.sendSRPProof(srpClient);
    const response = await this.networkClient.receiveResponse();
    this.validateSRPProofResponse(response);

    log.debug('SRP authentication completed');
    return srpClient;
  }

  private async resolveSrpPassword(): Promise<string> {
    if (isAppleTvModel(this.peerDeviceInfo?.model)) {
      log.info('Apple TV–class device: enter the on-screen pairing PIN');
      return await this.userInput.promptForPIN();
    }
    log.debug('Using default SRP password for iOS/iPadOS-style remote pairing');
    return '000000';
  }

  private async receiveM6Completion(decryptKey: Buffer): Promise<void> {
    const m6Response = await this.networkClient.receiveResponse();
    log.info('M6 Response received');

    try {
      this.processM6Response(m6Response, decryptKey);
    } catch (error) {
      log.warn(
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

  private createPairVerifyFailedRequest(): PairingRequest {
    return this.createRequest({
      event: {
        _0: {
          pairVerifyFailed: {},
        },
      },
    });
  }

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
          'Device returned empty error buffer',
          'INVALID_ERROR_RESPONSE',
        );
      }
      const errorCode = errorBuffer[0];
      throw new PairingError(
        `Device rejected request with error ${errorCode}`,
        'DEVICE_PAIRING_ERROR',
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
      const deviceInfo = encodePairingControllerDeviceInfo(devicePairingID);

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

  private processM6Response(m6Response: any, decryptKey: Buffer): void {
    if (!m6Response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      return;
    }

    const m6DataBase64 =
      m6Response.message.plain._0.event._0.pairingData._0.data;
    const m6TLVBuffer = Buffer.from(m6DataBase64, 'base64');
    const m6Parsed = decodeTLV8ToDict(m6TLVBuffer);

    log.debug(
      'M6 TLV types received:',
      Object.keys(m6Parsed).map((k) => `0x${Number(k).toString(16)}`),
    );

    const stateData = m6Parsed[PairingDataComponentType.STATE];
    if (stateData && stateData[0] === PAIRING_STATES.M6) {
      log.info('Pairing completed successfully (STATE=0x06)');
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
      log.debug('M6 decrypted content types:', Object.keys(decryptedTLV));
    }
  }

  private deriveEncryptionKeys(sessionKey: Buffer): EncryptionKeys {
    const sharedKey = hkdf({
      ikm: sessionKey,
      salt: Buffer.from(PAIRING_MESSAGES.ENCRYPT_SALT, 'utf8'),
      info: Buffer.from(PAIRING_MESSAGES.ENCRYPT_INFO, 'utf8'),
      length: 32,
    });

    log.debug('Derived Pair-Setup encryption keys');
    return {
      encryptKey: sharedKey,
      decryptKey: sharedKey,
    };
  }

  /**
   * pymobiledevice3 _create_remote_unlock — encrypted createRemoteUnlockKey request.
   */
  private async createRemoteUnlockKey(sessionKey: Buffer): Promise<string> {
    const clientEncryptionKey = hkdf({
      ikm: sessionKey,
      salt: null,
      info: Buffer.from(ENCRYPTION_MESSAGES.CLIENT_ENCRYPT),
      length: 32,
    });
    const serverEncryptionKey = hkdf({
      ikm: sessionKey,
      salt: null,
      info: Buffer.from(ENCRYPTION_MESSAGES.SERVER_ENCRYPT),
      length: 32,
    });

    let encryptedSequenceNumber = 0;

    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(encryptedSequenceNumber), 0);

    const requestPayload = {
      request: { _0: { createRemoteUnlockKey: {} } },
    };
    const encrypted = encryptChaCha20Poly1305({
      plaintext: Buffer.from(JSON.stringify(requestPayload), 'utf8'),
      key: clientEncryptionKey,
      nonce,
    });

    const encryptedPayload = {
      message: {
        streamEncrypted: {
          _0: encrypted.toString('base64'),
        },
      },
      originatedBy: 'host',
      sequenceNumber: this._sequenceNumber++,
    };

    await this.networkClient.sendPacket(encryptedPayload);
    encryptedSequenceNumber++;

    const response = await this.networkClient.receiveResponse();
    const encData = response.message?.streamEncrypted?._0;
    if (!encData) {
      throw new PairingError(
        'Missing encrypted response for createRemoteUnlockKey',
        'REMOTE_UNLOCK_NO_RESPONSE',
      );
    }

    const responseNonce = Buffer.alloc(12);
    responseNonce.writeBigUInt64LE(BigInt(encryptedSequenceNumber - 1), 0);

    const decrypted = decryptChaCha20Poly1305({
      ciphertext: Buffer.from(encData, 'base64'),
      key: serverEncryptionKey,
      nonce: responseNonce,
    });

    const responseJson = JSON.parse(decrypted.toString('utf8'));
    const err = responseJson?.response?._1?.errorExtended;
    if (err) {
      const msg =
        err?._0?.userInfo?.NSLocalizedDescription ??
        'createRemoteUnlockKey failed';
      throw new PairingError(String(msg), 'REMOTE_UNLOCK_ERROR', err);
    }

    const hostKey = responseJson?.response?._1?.createRemoteUnlockKey?.hostKey;
    return typeof hostKey === 'string' ? hostKey : '';
  }

  private async createPairingResult(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey: string,
    storage: PairingStorage,
  ): Promise<string> {
    return await storage.save(deviceId, ltpk, ltsk, remoteUnlockHostKey);
  }
}
