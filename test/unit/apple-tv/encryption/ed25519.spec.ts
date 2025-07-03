import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  createEd25519Signature,
  generateEd25519KeyPair,
} from '../../../../src/lib/apple-tv/encryption/ed25519.js';
import { CryptographyError } from '../../../../src/lib/apple-tv/errors.js';

describe('Apple TV Encryption - Ed25519', () => {
  describe('generateEd25519KeyPair', () => {
    it('should generate a valid key pair', () => {
      const keyPair = generateEd25519KeyPair();

      expect(keyPair).to.have.property('publicKey');
      expect(keyPair).to.have.property('privateKey');
      expect(keyPair.publicKey).to.be.instanceOf(Buffer);
      expect(keyPair.privateKey).to.be.instanceOf(Buffer);
      expect(keyPair.publicKey.length).to.equal(32);
      expect(keyPair.privateKey.length).to.equal(32);
    });

    it('should generate different key pairs each time', () => {
      const keyPair1 = generateEd25519KeyPair();
      const keyPair2 = generateEd25519KeyPair();

      expect(keyPair1.publicKey.equals(keyPair2.publicKey)).to.be.false;
      expect(keyPair1.privateKey.equals(keyPair2.privateKey)).to.be.false;
    });
  });

  describe('createEd25519Signature', () => {
    let validPrivateKey: Buffer;

    beforeEach(function () {
      const keyPair = generateEd25519KeyPair();
      validPrivateKey = keyPair.privateKey;
    });

    it('should create a valid signature', () => {
      const data = Buffer.from('Hello, World!', 'utf8');
      const signature = createEd25519Signature(data, validPrivateKey);

      expect(signature).to.be.instanceOf(Buffer);
      expect(signature.length).to.equal(64);
    });

    it('should create consistent signatures for same data and key', () => {
      const data = Buffer.from('Test message', 'utf8');

      const signature1 = createEd25519Signature(data, validPrivateKey);
      const signature2 = createEd25519Signature(data, validPrivateKey);

      expect(signature1.equals(signature2)).to.be.true;
    });

    it('should create different signatures for different data', () => {
      const data1 = Buffer.from('Message 1', 'utf8');
      const data2 = Buffer.from('Message 2', 'utf8');

      const signature1 = createEd25519Signature(data1, validPrivateKey);
      const signature2 = createEd25519Signature(data2, validPrivateKey);

      expect(signature1.equals(signature2)).to.be.false;
    });

    it('should throw when data is empty', () => {
      const emptyData = Buffer.alloc(0);

      expect(() => createEd25519Signature(emptyData, validPrivateKey)).to.throw(
        CryptographyError,
        'Data to sign cannot be empty',
      );
    });

    it('should throw when private key is wrong size', () => {
      const data = Buffer.from('test', 'utf8');
      const shortKey = Buffer.alloc(16);

      expect(() => createEd25519Signature(data, shortKey)).to.throw(
        CryptographyError,
        'Private key must be 32 bytes',
      );
    });
  });
});
