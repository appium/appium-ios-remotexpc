import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {SRP_KEY_LENGTH_BYTES, SRP_USERNAME} from '../../../../src/lib/apple-tv/constants.js';
import {SRPError} from '../../../../src/lib/apple-tv/errors.js';
import {SRPClient} from '../../../../src/lib/apple-tv/srp/srp-client.js';

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
      assert.ok(client instanceof SRPClient);
      assert.strictEqual(client.isReady(), false);
      assert.strictEqual(client.hasSessionKey(), false);
    });
  });

  describe('setIdentity', function () {
    it('should set identity with valid username and password', function () {
      assert.doesNotThrow(function () {
        client.setIdentity('testuser', 'testpass');
      });
    });

    it('should throw error for empty password', function () {
      assert.throws(
        function () {
          client.setIdentity('testuser', '');
        },
        (err: any) => err instanceof SRPError && err.message.includes('Password cannot be empty'),
      );
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      assert.throws(
        function () {
          client.setIdentity('testuser', 'testpass');
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('setSalt', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error for empty salt', function () {
      assert.throws(
        function () {
          client.salt = Buffer.alloc(0);
        },
        (err: any) => err instanceof SRPError && err.message.includes('Salt cannot be empty'),
      );
    });

    it('should generate keys when both salt and server public key are set', function () {
      const salt = randomBytes(16);
      const serverPublicKey = randomBytes(SRP_KEY_LENGTH_BYTES);

      client.salt = salt;
      client.serverPublicKey = serverPublicKey;

      assert.strictEqual(client.isReady(), true);
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      assert.throws(
        function () {
          client.salt = randomBytes(16);
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('setServerPublicKey', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error for wrong size key', function () {
      const wrongSizeKey = randomBytes(100);

      assert.throws(
        function () {
          client.serverPublicKey = wrongSizeKey;
        },
        (err: any) =>
          err instanceof SRPError &&
          err.message.includes(`Server public key must be ${SRP_KEY_LENGTH_BYTES} bytes, got 100`),
      );
    });

    it('should throw error for B = 0', function () {
      const zeroB = Buffer.alloc(SRP_KEY_LENGTH_BYTES, 0);

      assert.throws(
        function () {
          client.serverPublicKey = zeroB;
        },
        (err: any) =>
          err instanceof SRPError && err.message.includes('Invalid server public key B: must be in range (1, N-1)'),
      );
    });

    it('should throw error when client is disposed', function () {
      client.dispose();

      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      assert.throws(
        function () {
          client.serverPublicKey = validB;
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('getPublicKey', function () {
    it('should throw error when keys not generated', function () {
      assert.throws(
        function () {
          client.publicKey;
        },
        (err: any) =>
          err instanceof SRPError &&
          err.message.includes('Client keys not generated yet. Set salt and serverPublicKey properties first.'),
      );
    });

    it('should return public key after keys are generated', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;

      const publicKey = client.publicKey;

      assert.ok(publicKey instanceof Buffer);
      assert.strictEqual(publicKey.length, SRP_KEY_LENGTH_BYTES);
    });

    it('should throw error when client is disposed', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;
      client.dispose();

      assert.throws(
        function () {
          client.publicKey;
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('computeProof', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error when password not set', function () {
      const newClient = new SRPClient();

      assert.throws(
        function () {
          newClient.computeProof();
        },
        (err: any) =>
          err instanceof SRPError &&
          err.message.includes('Password must be set before performing operations. Call setIdentity() first.'),
      );
    });

    it('should throw error when salt not set', function () {
      assert.throws(
        function () {
          client.computeProof();
        },
        (err: any) => err instanceof SRPError && err.message.includes('Salt and server public key must be set first'),
      );
    });

    it('should compute proof when all parameters are set', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;

      const proof = client.computeProof();

      assert.ok(proof instanceof Buffer);
      assert.strictEqual(proof.length, 64);
    });

    it('should produce different proofs for different passwords', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;
      const proof1 = client.computeProof();

      const client2 = new SRPClient();
      client2.setIdentity(SRP_USERNAME, 'differentpass');
      client2.salt = salt;
      client2.serverPublicKey = validB;
      const proof2 = client2.computeProof();

      assert.strictEqual(proof1.equals(proof2), false);

      client2.dispose();
    });

    it('should throw error when client is disposed', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;
      client.dispose();

      assert.throws(
        function () {
          client.computeProof();
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('getSessionKey', function () {
    beforeEach(function () {
      client.setIdentity(SRP_USERNAME, 'testpass');
    });

    it('should throw error when password not set', function () {
      const newClient = new SRPClient();

      assert.throws(
        function () {
          newClient.sessionKey;
        },
        (err: any) =>
          err instanceof SRPError &&
          err.message.includes('Password must be set before performing operations. Call setIdentity() first.'),
      );
    });

    it('should throw error when session key not computed', function () {
      assert.throws(
        function () {
          client.sessionKey;
        },
        (err: any) => err instanceof SRPError && err.message.includes('Salt and server public key must be set first'),
      );
    });

    it('should return session key after computation', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;

      const sessionKey = client.sessionKey;

      assert.ok(sessionKey instanceof Buffer);
      assert.strictEqual(sessionKey.length, 64);
    });

    it('should throw error when client is disposed', function () {
      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;
      client.sessionKey;
      client.dispose();

      assert.throws(
        function () {
          client.sessionKey;
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
    });
  });

  describe('dispose', function () {
    it('should clear sensitive data', function () {
      client.setIdentity(SRP_USERNAME, 'testpass');

      const salt = randomBytes(16);
      const validB = Buffer.alloc(SRP_KEY_LENGTH_BYTES);
      validB.fill(0xff);
      validB[0] = 0x02;

      client.salt = salt;
      client.serverPublicKey = validB;
      client.sessionKey;

      assert.strictEqual(client.isReady(), true);
      assert.strictEqual(client.hasSessionKey(), true);

      client.dispose();

      assert.strictEqual(client.isReady(), false);
      assert.strictEqual(client.hasSessionKey(), false);
    });

    it('should prevent further operations', function () {
      client.dispose();

      assert.throws(
        function () {
          client.setIdentity(SRP_USERNAME, 'testpass');
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );

      assert.throws(
        function () {
          client.salt = randomBytes(16);
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );

      assert.throws(
        function () {
          client.publicKey;
        },
        (err: any) => err instanceof SRPError && err.message.includes('SRP client has been disposed'),
      );
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

      client.salt = salt;
      client.serverPublicKey = validB;

      const sessionKey = client.sessionKey;
      assert.ok(sessionKey instanceof Buffer);
      assert.strictEqual(sessionKey.length, 64);
    });
  });
});
