import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';

import {PairingDataComponentType} from '../../../src/lib/apple-tv/constants.js';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  hkdf,
  performX25519DiffieHellman,
  type X25519KeyPair,
} from '../../../src/lib/apple-tv/encryption/index.js';
import {PairingError} from '../../../src/lib/apple-tv/errors.js';
import type {NetworkClientInterface} from '../../../src/lib/apple-tv/network/types.js';
import {PAIR_VERIFY_STATES} from '../../../src/lib/apple-tv/pairing-protocol/constants.js';
import {PairVerificationProtocol} from '../../../src/lib/apple-tv/pairing-protocol/pair-verification-protocol.js';
import type {PairingRequest} from '../../../src/lib/apple-tv/pairing-protocol/types.js';
import type {PairRecord} from '../../../src/lib/apple-tv/storage/types.js';
import {decodeTLV8ToDict, encodeTLV8} from '../../../src/lib/apple-tv/tlv/index.js';
import type {PairingKeys} from '../../../src/lib/apple-tv/types.js';

interface PairingDataResponse {
  message: {plain: {_0: {event: {_0: {pairingData: {_0: {data: string}}}}}}};
}

const DEVICE_ID = 'AA:BB:CC:DD:EE:FF';

function wrapStateResponse(tlv: Buffer): PairingDataResponse {
  return {message: {plain: {_0: {event: {_0: {pairingData: {_0: {data: tlv.toString('base64')}}}}}}}};
}

function extractTlv(packet: PairingRequest): Partial<Record<number, Buffer>> {
  const payload = packet.message.plain._0;
  assert.ok('event' in payload, 'sent packet is missing pairing event payload');
  const data = payload.event._0.pairingData?._0.data;
  assert.ok(data, 'sent packet is missing pairing data');
  return decodeTLV8ToDict(Buffer.from(data, 'base64'));
}

function buildState2(): {deviceKeys: X25519KeyPair; response: PairingDataResponse} {
  const deviceKeys = generateX25519KeyPair();
  const response = wrapStateResponse(
    encodeTLV8([
      {type: PairingDataComponentType.STATE, data: Buffer.from([PAIR_VERIFY_STATES.STATE_02])},
      {type: PairingDataComponentType.PUBLIC_KEY, data: deviceKeys.publicKey},
    ]),
  );
  return {deviceKeys, response};
}

function buildState4(): PairingDataResponse {
  return wrapStateResponse(
    encodeTLV8([{type: PairingDataComponentType.STATE, data: Buffer.from([PAIR_VERIFY_STATES.STATE_04])}]),
  );
}

function createTransport(respond: (sentPackets: PairingRequest[]) => PairingDataResponse): NetworkClientInterface {
  const sentPackets: PairingRequest[] = [];
  return {
    connect: async () => {},
    sendPacket: async (data: PairingRequest) => {
      sentPackets.push(data);
    },
    receiveResponse: async () => respond(sentPackets),
    disconnect: () => {},
  };
}

describe('Apple TV - PairVerificationProtocol', function () {
  let hostKeys: PairingKeys;
  let pairRecord: PairRecord;

  beforeEach(function () {
    hostKeys = generateEd25519KeyPair();
    pairRecord = {
      publicKey: hostKeys.publicKey,
      privateKey: hostKeys.privateKey,
      remoteUnlockHostKey: '',
    };
  });

  it('should complete verification and derive session keys from the ephemeral exchange', async function () {
    let deviceKeys: X25519KeyPair | undefined;
    let clientPublicKey: Buffer | undefined;
    const transport = createTransport((sent) => {
      if (sent.length === 1) {
        clientPublicKey = extractTlv(sent[0])[PairingDataComponentType.PUBLIC_KEY];
        const state2 = buildState2();
        deviceKeys = state2.deviceKeys;
        return state2.response;
      }
      return buildState4();
    });
    const protocol = new PairVerificationProtocol(transport);

    const keys = await protocol.verify(pairRecord, DEVICE_ID);

    assert.ok(deviceKeys);
    assert.ok(clientPublicKey);
    const sharedSecret = performX25519DiffieHellman(deviceKeys.privateKey, clientPublicKey);
    const expectedServerKey = hkdf({
      ikm: sharedSecret,
      salt: null,
      info: Buffer.from('ServerEncrypt-main'),
      length: 32,
    });
    assert.ok(keys.clientEncryptionKey.length === 32);
    assert.ok(keys.serverEncryptionKey.equals(expectedServerKey));
  });

  it('should translate malformed STATE=2 TLV8 payloads into TLV8_PARSE_ERROR', async function () {
    const transport = createTransport(() => wrapStateResponse(Buffer.from([0x06])));
    const protocol = new PairVerificationProtocol(transport);

    await assert.rejects(protocol.verify(pairRecord, DEVICE_ID), (err: unknown) => {
      assert.ok(err instanceof PairingError);
      assert.strictEqual(err.code, 'TLV8_PARSE_ERROR');
      return true;
    });
  });
});
