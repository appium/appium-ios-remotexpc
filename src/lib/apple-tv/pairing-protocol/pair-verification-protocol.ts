import { type KeyObject } from 'node:crypto';
import { hostname } from 'node:os';

import { getLogger } from '../../logger.js';
import { PairingDataComponentType } from '../constants.js';
import {
  createEd25519Signature,
  encryptChaCha20Poly1305,
  generateX25519KeyPair,
  hkdf,
  performX25519DiffieHellman,
} from '../encryption/index.js';
import { PairingError } from '../errors.js';
import type { NetworkClientInterface } from '../network/types.js';
import type { PairRecord } from '../storage/types.js';
import { decodeTLV8ToDict, encodeTLV8 } from '../tlv/index.js';
import { generateHostId } from '../utils/uuid-generator.js';
import {
  ENCRYPTION_MESSAGES,
  PAIR_VERIFY_ERROR_DESCRIPTIONS,
  PAIR_VERIFY_MESSAGES,
  PAIR_VERIFY_STATES,
} from './constants.js';
import type { PairingRequest } from './types.js';

const log = getLogger('PairVerificationProtocol');

export interface VerificationKeys {
  encryptionKey: Buffer;
  clientEncryptionKey: Buffer;
  serverEncryptionKey: Buffer;
}

export class PairVerificationProtocol {
  private readonly hostIdentifier: string;
  private sequenceNumber: number = 0;

  constructor(private readonly networkClient: NetworkClientInterface) {
    this.hostIdentifier = generateHostId(hostname());
  }

  async verify(
    pairRecord: PairRecord,
    deviceId: string,
  ): Promise<VerificationKeys> {
    log.debug('Starting pair verification (4-step process)');

    const { publicKey, privateKey } = generateX25519KeyPair();

    log.debug('  - STATE=1: Send X25519 public key to device');
    await this.sendState1(publicKey);

    const devicePublicKey = await this.processState2Response();

    const sharedSecret = this.computeSharedSecret(privateKey, devicePublicKey);
    const pairVerifyKey = this.derivePairVerifyKey(sharedSecret);

    log.debug(
      '  - STATE=3: Send encrypted signature using Ed25519 private key from pair record',
    );
    log.debug(`    Using pair record: ${deviceId}`);

    await this.sendState3(
      pairRecord,
      publicKey,
      devicePublicKey,
      pairVerifyKey,
    );

    await this.validateState4Response();

    log.debug('  - STATE=4: Receive verification success from device');

    return this.deriveEncryptionKeys(sharedSecret);
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }

  setSequenceNumber(value: number): void {
    this.sequenceNumber = value;
  }

  private async processState2Response(): Promise<Buffer> {
    const state2Response = await this.networkClient.receiveResponse();

    const pairingData =
      state2Response.message?.plain?._0?.event?._0?.pairingData?._0?.data;
    if (!pairingData) {
      throw new PairingError(
        'No pairing data in STATE=2 response',
        'STATE_2_NO_DATA',
      );
    }

    const tlvData = decodeTLV8ToDict(Buffer.from(pairingData, 'base64'));

    if (tlvData[PairingDataComponentType.ERROR]) {
      const errorCode = tlvData[PairingDataComponentType.ERROR] as Buffer;
      const errorDecimal = errorCode[0];
      log.error(
        `Device returned error in STATE=2: ${errorCode.toString('hex')} (decimal: ${errorDecimal})`,
      );
      throw new PairingError(
        `Authentication failed at STATE=2 (error: ${errorDecimal})`,
        'STATE_2_ERROR',
      );
    }

    const devicePublicKey = tlvData[PairingDataComponentType.PUBLIC_KEY];
    if (!devicePublicKey) {
      throw new PairingError(
        'No device public key in STATE=2',
        'STATE_2_NO_PUBLIC_KEY',
      );
    }

    log.debug(' - STATE=2: Receive devices X25519 public key + encrypted data');

    return devicePublicKey;
  }

  private computeSharedSecret(
    privateKey: KeyObject,
    devicePublicKey: Buffer,
  ): Buffer {
    return performX25519DiffieHellman(privateKey, devicePublicKey);
  }

  private derivePairVerifyKey(sharedSecret: Buffer): Buffer {
    return hkdf({
      ikm: sharedSecret,
      salt: Buffer.from(PAIR_VERIFY_MESSAGES.ENCRYPT_SALT),
      info: Buffer.from(PAIR_VERIFY_MESSAGES.ENCRYPT_INFO),
      length: 32,
    });
  }

  private async validateState4Response(): Promise<void> {
    const state4Response = await this.networkClient.receiveResponse();

    const state4Data =
      state4Response.message?.plain?._0?.event?._0?.pairingData?._0?.data;
    if (!state4Data) {
      return;
    }

    const state4TLV = decodeTLV8ToDict(Buffer.from(state4Data, 'base64'));

    if (state4TLV[PairingDataComponentType.ERROR]) {
      const errorCode = state4TLV[PairingDataComponentType.ERROR] as Buffer;
      const errorDecimal = errorCode[0];

      const errorDescription =
        PAIR_VERIFY_ERROR_DESCRIPTIONS[errorDecimal] || 'Unknown error';

      log.error(
        `Device returned error in STATE=4: ${errorCode.toString('hex')} (decimal: ${errorDecimal})`,
      );
      log.error(`Error description: ${errorDescription}`);
      throw new PairingError(
        `Pair verification failed: ${errorDescription}`,
        'STATE_4_ERROR',
      );
    }
  }

  private createPairingPayload(
    data: string,
    startNewSession: boolean,
  ): PairingRequest {
    return {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairingData: {
                  _0: {
                    data,
                    kind: 'verifyManualPairing',
                    startNewSession,
                  },
                },
              },
            },
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };
  }

  private async sendState1(x25519PublicKey: Buffer): Promise<void> {
    const tlvData = encodeTLV8([
      {
        type: PairingDataComponentType.STATE,
        data: Buffer.from([PAIR_VERIFY_STATES.STATE_01]),
      },
      { type: PairingDataComponentType.PUBLIC_KEY, data: x25519PublicKey },
    ]);

    const payload = this.createPairingPayload(tlvData.toString('base64'), true);

    await this.networkClient.sendPacket(payload);
  }

  private async sendState3(
    pairRecord: PairRecord,
    x25519PublicKey: Buffer,
    devicePublicKey: Buffer,
    pairVerifyEncryptionKey: Buffer,
  ): Promise<void> {
    const signData = Buffer.concat([
      x25519PublicKey,
      Buffer.from(this.hostIdentifier, 'utf8'),
      devicePublicKey,
    ]);

    const signature = createEd25519Signature(signData, pairRecord.privateKey);

    const responseTLV = encodeTLV8([
      {
        type: PairingDataComponentType.IDENTIFIER,
        data: Buffer.from(this.hostIdentifier, 'utf8'),
      },
      { type: PairingDataComponentType.SIGNATURE, data: signature },
    ]);

    const nonce = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from(PAIR_VERIFY_MESSAGES.STATE_03_NONCE),
    ]);

    const encryptedResponse = encryptChaCha20Poly1305({
      plaintext: responseTLV,
      key: pairVerifyEncryptionKey,
      nonce,
    });

    const finalTLV = encodeTLV8([
      {
        type: PairingDataComponentType.STATE,
        data: Buffer.from([PAIR_VERIFY_STATES.STATE_03]),
      },
      {
        type: PairingDataComponentType.ENCRYPTED_DATA,
        data: encryptedResponse,
      },
    ]);

    const payload = this.createPairingPayload(
      finalTLV.toString('base64'),
      false,
    );

    await this.networkClient.sendPacket(payload);
  }

  private deriveEncryptionKeys(sharedSecret: Buffer): VerificationKeys {
    log.debug('Deriving main encryption keys');

    const clientEncryptionKey = hkdf({
      ikm: sharedSecret,
      salt: null,
      info: Buffer.from(ENCRYPTION_MESSAGES.CLIENT_ENCRYPT),
      length: 32,
    });

    const serverEncryptionKey = hkdf({
      ikm: sharedSecret,
      salt: null,
      info: Buffer.from(ENCRYPTION_MESSAGES.SERVER_ENCRYPT),
      length: 32,
    });

    log.debug('Derived client/server encryption keys using HKDF');

    return {
      encryptionKey: sharedSecret,
      clientEncryptionKey,
      serverEncryptionKey,
    };
  }
}
