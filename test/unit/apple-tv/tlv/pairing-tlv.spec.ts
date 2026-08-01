import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PairingDataComponentType} from '../../../../src/lib/apple-tv/constants.js';
import {decodeTLV8ToDict} from '../../../../src/lib/apple-tv/tlv/decoder.js';
import {
  createPairVerificationData,
  createSetupManualPairingData,
} from '../../../../src/lib/apple-tv/tlv/pairing-tlv.js';

describe('Pairing TLV', function () {
  describe('createSetupManualPairingData', function () {
    it('should create valid base64-encoded TLV8 data', function () {
      const result = createSetupManualPairingData();

      assert.ok(typeof result === 'string');
      assert.doesNotThrow(() => Buffer.from(result, 'base64'));
    });

    it('should contain correct METHOD and STATE values', function () {
      const result = createSetupManualPairingData();
      const decoded = Buffer.from(result, 'base64');
      const tlvDict = decodeTLV8ToDict(decoded);

      assert.ok(
        tlvDict[PairingDataComponentType.METHOD] !== null && tlvDict[PairingDataComponentType.METHOD] !== undefined,
      );
      assert.deepStrictEqual(tlvDict[PairingDataComponentType.METHOD], Buffer.from([0x00]));

      assert.ok(
        tlvDict[PairingDataComponentType.STATE] !== null && tlvDict[PairingDataComponentType.STATE] !== undefined,
      );
      assert.deepStrictEqual(tlvDict[PairingDataComponentType.STATE], Buffer.from([0x01]));
    });

    it('should always return the same value', function () {
      const result1 = createSetupManualPairingData();
      const result2 = createSetupManualPairingData();

      assert.strictEqual(result1, result2);
    });
  });

  describe('createPairVerificationData', function () {
    it('should create valid base64-encoded TLV8 data with public key', function () {
      const publicKey = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const result = createPairVerificationData(publicKey);

      assert.ok(typeof result === 'string');
      assert.doesNotThrow(() => Buffer.from(result, 'base64'));
    });

    it('should contain correct STATE and PUBLIC_KEY values', function () {
      const publicKey = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
      const result = createPairVerificationData(publicKey);
      const decoded = Buffer.from(result, 'base64');
      const tlvDict = decodeTLV8ToDict(decoded);

      assert.ok(
        tlvDict[PairingDataComponentType.STATE] !== null && tlvDict[PairingDataComponentType.STATE] !== undefined,
      );
      assert.deepStrictEqual(tlvDict[PairingDataComponentType.STATE], Buffer.from([0x01]));

      assert.ok(
        tlvDict[PairingDataComponentType.PUBLIC_KEY] !== null &&
          tlvDict[PairingDataComponentType.PUBLIC_KEY] !== undefined,
      );
      assert.deepStrictEqual(tlvDict[PairingDataComponentType.PUBLIC_KEY], publicKey);
    });

    it('should handle typical X25519 public key (32 bytes)', function () {
      const x25519PublicKey = Buffer.alloc(32, 0xef);
      const result = createPairVerificationData(x25519PublicKey);
      const decoded = Buffer.from(result, 'base64');
      const tlvDict = decodeTLV8ToDict(decoded);

      assert.deepStrictEqual(tlvDict[PairingDataComponentType.PUBLIC_KEY], x25519PublicKey);
    });

    it('should handle large public key that requires fragmentation', function () {
      const largeKey = Buffer.alloc(300, 0x42);
      const result = createPairVerificationData(largeKey);
      const decoded = Buffer.from(result, 'base64');
      const tlvDict = decodeTLV8ToDict(decoded);

      assert.deepStrictEqual(tlvDict[PairingDataComponentType.PUBLIC_KEY], largeKey);
    });

    it('should produce different results for different public keys', function () {
      const key1 = Buffer.from([0x01, 0x02, 0x03]);
      const key2 = Buffer.from([0x04, 0x05, 0x06]);

      const result1 = createPairVerificationData(key1);
      const result2 = createPairVerificationData(key2);

      assert.notStrictEqual(result1, result2);
    });
  });
});
