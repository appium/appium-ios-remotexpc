import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { randomBytes } from 'node:crypto';

import {
  SRP_KEY_LENGTH_BYTES,
  SRP_USERNAME,
} from '../../../../src/lib/apple-tv/constants.js';
import { SRPError } from '../../../../src/lib/apple-tv/errors.js';
import { SRPClient } from '../../../../src/lib/apple-tv/srp/srp-client.js';

describe('Apple TV SRP - SRP Client', function () {
  let client: SRPClient;

  beforeEach(function () {
    client = new SRPClient();
  });

  afterEach(function () {
    if (client) {
      client.dispose();
    }
  });

  describe('constructor', function () {
    it('should initialize with default values', function () {
      expect(client).to.be.instanceOf(SRPClient);
      expect(client.isReady()).to.be.false;
      expect(client.hasSessionKey()).to.be.false;
    });
  });

  describe('setIdentity', function () {
    it('should set identity with valid username and password', function () {
      expect(function () {
        client.setIdentity('testuser', 'testpass');
      }).to.not.throw();
    });

    it('should throw error for empty password', function () {
      expect(function () {
        client.setIdentity('testuser', '');
      }).to.throw(SRPError, 'Password cannot be empty');
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      expect(function () {
        client.setIdentity('testuser', 'testpass');
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('setSalt', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error for empty salt', function () {
      expect(function () {
        client.setSalt(Buffer.alloc(0));
      }).to.throw(SRPError, 'Salt cannot be empty');
    });

    it('should generate keys when both salt and server public key are set', function () {
      const salt = randomBytes(16);
      const serverPublicKey = randomBytes(SRP_KEY_LENGTH_BYTES);

      client.setSalt(salt);
      client.setServerPublicKey(serverPublicKey);

      expect(client.isReady()).to.be.true;
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      expect(function () {
        client.setSalt(randomBytes(16));
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('setServerPublicKey', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error for wrong size key', function () {
      const wrongSizeKey = randomBytes(100);

      expect(function () {
        client.setServerPublicKey(wrongSizeKey);
      }).to.throw(
        SRPError,
        `Server public key must be ${SRP_KEY_LENGTH_BYTES} bytes, got 100`,
      );
    });

    it('should throw error for B = 0', function () {
      const zeroB = Buffer.alloc(SRP_KEY_LENGTH_BYTES, 0);

      expect(function () {
        client.setServerPublicKey(zeroB);
      }).to.throw(
        SRPError,
        'Invalid server public key B: must be in range (1, N-1)',
      );
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      expect(function () {
        client.setServerPublicKey(validB);
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('getPublicKey', function () {
    it('should throw error when keys not generated', function () {
      expect(function () {
        client.getPublicKey();
      }).to.throw(
        SRPError,
        'Client keys not generated yet. Call setSalt() and setServerPublicKey() first.',
      );
    });

    it('should return public key after keys are generated', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);

      const publicKey = client.getPublicKey();

      expect(publicKey).to.be.instanceOf(Buffer);
      expect(publicKey.length).to.equal(SRP_KEY_LENGTH_BYTES);
    });

    it('should throw error when client is disposed', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);
      client.dispose();

      expect(function () {
        client.getPublicKey();
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('computeProof', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error when password not set', function () {
      const newClient = new SRPClient();

      expect(function () {
        newClient.computeProof();
      }).to.throw(
        SRPError,
        'Password must be set before performing operations. Call setIdentity() first.',
      );
    });

    it('should throw error when salt not set', function () {
      expect(function () {
        client.computeProof();
      }).to.throw(SRPError, 'Salt and server public key must be set first');
    });

    it('should compute proof when all parameters are set', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);

      const proof = client.computeProof();

      expect(proof).to.be.instanceOf(Buffer);
      expect(proof.length).to.equal(64);
    });

    it('should produce different proofs for different passwords', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);
      const proof1 = client.computeProof();

      const client2 = new SRPClient();
      client2.setIdentity(SRP_USERNAME, 'differentpass');
      client2.setSalt(salt);
      client2.setServerPublicKey(validB);
      const proof2 = client2.computeProof();

      expect(proof1.equals(proof2)).to.be.false;

      client2.dispose();
    });

    it('should throw error when client is disposed', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);
      client.dispose();

      expect(function () {
        client.computeProof();
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('getSessionKey', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error when password not set', function () {
      const newClient = new SRPClient();

      expect(function () {
        newClient.getSessionKey();
      }).to.throw(
        SRPError,
        'Password must be set before performing operations. Call setIdentity() first.',
      );
    });

    it('should throw error when session key not computed', function () {
      expect(function () {
        client.getSessionKey();
      }).to.throw(SRPError, 'Salt and server public key must be set first');
    });

    it('should return session key after computation', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);

      const sessionKey = client.getSessionKey();

      expect(sessionKey).to.be.instanceOf(Buffer);
      expect(sessionKey.length).to.equal(64);
    });

    it('should throw error when client is disposed', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);
      client.getSessionKey();
      client.dispose();

      expect(function () {
        client.getSessionKey();
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('dispose', function () {
    it('should clear sensitive data', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.setSalt(salt);
      client.setServerPublicKey(validB);
      client.getSessionKey();

      expect(client.isReady()).to.be.true;
      expect(client.hasSessionKey()).to.be.true;

      client.dispose();

      expect(client.isReady()).to.be.false;
      expect(client.hasSessionKey()).to.be.false;
    });

    it('should prevent further operations', function () {
      client.dispose();

      expect(function () {
        client.setIdentity(SRP_USERNAME, 'testpass');
      }).to.throw(SRPError, 'SRP client has been disposed');

      expect(function () {
        client.setSalt(randomBytes(16));
      }).to.throw(SRPError, 'SRP client has been disposed');

      expect(function () {
        client.getPublicKey();
      }).to.throw(SRPError, 'SRP client has been disposed');
    });
  });

  describe('shared secret computation', function () {
    it('should compute shared secret with valid parameters', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB[0] = 0x12;
      validB[1] = 0x34;
      validB[2] = 0x56;

      client.setSalt(salt);
      client.setServerPublicKey(validB);

      const sessionKey = client.getSessionKey();
      expect(sessionKey).to.be.instanceOf(Buffer);
      expect(sessionKey.length).to.equal(64);
    });
  });
});
