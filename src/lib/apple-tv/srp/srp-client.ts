import { logger } from '@appium/support';
import { randomBytes } from 'node:crypto';

import {
  SRP_GENERATOR,
  SRP_KEY_LENGTH_BYTES,
  SRP_PRIME_3072,
  SRP_PRIVATE_KEY_BITS,
  SRP_USERNAME,
} from '../constants.js';
import { SRPError } from '../errors.js';
import {
  bigIntToBuffer,
  bufferToBigInt,
  modPow,
} from '../utils/buffer-utils.js';
import {
  calculateK,
  calculateM1,
  calculateU,
  calculateX,
  hash,
} from './crypto-utils.js';

const log = logger.getLogger('SRPClient');

/**
 * SRP (Secure Remote Password) client implementation following RFC 5054.
 *
 * This class handles the client-side operations of the SRP protocol,
 * including key generation, authentication proof computation, and
 * session key derivation.
 */
export class SRPClient {
  // Constants
  private static readonly ZERO = BigInt(0);
  private static readonly ONE = BigInt(1);
  private static readonly MAX_KEY_GENERATION_ATTEMPTS = 100;

  private readonly N = SRP_PRIME_3072;
  private readonly g = SRP_GENERATOR;
  private readonly k: bigint;
  private readonly N_MINUS_ONE: bigint;

  private username: string;
  private password: string;
  private _salt: Buffer | null = null;
  private _a: bigint = SRPClient.ZERO;
  private _A: bigint = SRPClient.ZERO;
  private _B: bigint | null = null;
  private _S: bigint | null = null;
  private _K: Buffer | null = null;

  // State tracking
  private keysGenerated = false;
  private disposed = false;

  constructor() {
    this.k = calculateK(this.N, this.g, SRP_KEY_LENGTH_BYTES);
    this.N_MINUS_ONE = this.N - SRPClient.ONE;
    this.username = SRP_USERNAME;
    this.password = '';

    log.debug('Initialized SRP client with k value');
  }

  /**
   * Sets the user identity credentials.
   * Note: Username is set to SRP_USERNAME constant, but can be overridden.
   *
   * @param username - The username for authentication
   * @param password - The password for authentication
   * @throws {SRPError} If username or password is empty
   */
  public setIdentity(username: string, password: string): void {
    this.throwIfDisposed();

    if (!username?.trim()) {
      throw new SRPError('Username cannot be empty');
    }
    if (!password) {
      throw new SRPError('Password cannot be empty');
    }

    this.username = username.trim();
    this.password = password;

    log.debug('Identity set successfully');
  }

  /**
   * Gets the salt value received from the server.
   *
   * @returns The salt buffer or null if not set
   */
  get salt(): Buffer | null {
    return this._salt;
  }

  /**
   * Sets the salt value received from the server.
   *
   * @param value - The salt buffer from the server
   * @throws {SRPError} If salt is empty or client is disposed
   */
  set salt(value: Buffer) {
    this.throwIfDisposed();

    if (!value || value.length === 0) {
      throw new SRPError('Salt cannot be empty');
    }

    this._salt = value;
    this.generateClientKeysIfReady();

    log.debug('Salt set successfully');
  }

  /**
   * Gets the server's public key B.
   *
   * @returns The server's public key as a Buffer or null if not set
   */
  get serverPublicKey(): Buffer | null {
    return this._B ? bigIntToBuffer(this._B, SRP_KEY_LENGTH_BYTES) : null;
  }

  /**
   * Sets the server's public key B.
   *
   * @param value - The server's public key as a Buffer
   * @throws {SRPError} If the server public key is invalid or client is disposed
   */
  set serverPublicKey(value: Buffer) {
    this.throwIfDisposed();

    if (!value || value.length !== SRP_KEY_LENGTH_BYTES) {
      throw new SRPError(
        `Server public key must be ${SRP_KEY_LENGTH_BYTES} bytes, got ${value?.length || 0}`,
      );
    }

    this._B = bufferToBigInt(value);

    if (this._B <= SRPClient.ONE || this._B >= this.N_MINUS_ONE) {
      throw new SRPError(
        'Invalid server public key B: must be in range (1, N-1)',
      );
    }

    // Additional security check
    if (this._B % this.N === SRPClient.ZERO) {
      throw new SRPError('Invalid server public key B: divisible by N');
    }

    this.generateClientKeysIfReady();
    log.debug('Server public key set successfully');
  }

  /**
   * Gets the client's public key A.
   *
   * @returns The client's public key as a Buffer
   * @throws {SRPError} If keys are not generated yet or client is disposed
   */
  get publicKey(): Buffer {
    this.throwIfDisposed();

    if (this._A === SRPClient.ZERO) {
      throw new SRPError(
        'Client keys not generated yet. Set salt and serverPublicKey properties first.',
      );
    }

    return bigIntToBuffer(this._A, SRP_KEY_LENGTH_BYTES);
  }

  /**
   * Computes the authentication proof M1.
   *
   * @returns The authentication proof as a Buffer
   * @throws {SRPError} If required parameters are not set or client is disposed
   */
  public computeProof(): Buffer {
    this.throwIfDisposed();
    this.validateIdentitySet();

    if (!this._K) {
      this.computeSharedSecret();
    }

    if (!this._salt || !this._K || !this._B) {
      throw new SRPError(
        'Cannot compute proof: salt, session key, and server public key must be set',
      );
    }

    return calculateM1(
      this.N,
      this.g,
      this.username,
      this._salt,
      this._A,
      this._B,
      this._K,
    );
  }

  /**
   * Gets the computed session key K.
   *
   * @returns The session key as a Buffer
   * @throws {SRPError} If session key is not computed or client is disposed
   */
  get sessionKey(): Buffer {
    this.throwIfDisposed();
    this.validateIdentitySet();

    if (!this._K) {
      this.computeSharedSecret();
    }

    if (!this._K) {
      throw new SRPError('Session key not computed');
    }

    return this._K;
  }

  /**
   * Checks if the client is ready to perform operations.
   *
   * @returns True if salt and server public key are set
   */
  public isReady(): boolean {
    return !this.disposed && !!(this._salt && this._B && this.keysGenerated);
  }

  /**
   * Checks if session key has been computed.
   *
   * @returns True if a session key is available
   */
  public hasSessionKey(): boolean {
    return !this.disposed && !!this._K;
  }

  /**
   * Clears sensitive data and disposes the client.
   * After calling this method, the client instance should not be used.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }

    // Clear sensitive data
    this.password = '';
    this._a = SRPClient.ZERO;

    if (this._K) {
      this._K.fill(0);
    }

    this._salt = null;
    this._S = null;
    this._B = null;
    this.disposed = true;

    log.debug('SRP client disposed and sensitive data cleared');
  }

  /**
   * Generates client keys if both salt and server public key are available.
   * This method ensures keys are generated only once.
   */
  private generateClientKeysIfReady(): void {
    if (this._salt && this._B && !this.keysGenerated) {
      this.generateClientKeys();
      this.keysGenerated = true;
    }
  }

  /**
   * Generates the client's private and public keys using cryptographically secure methods.
   *
   * @throws {SRPError} If generated public key is invalid or key generation fails
   */
  private generateClientKeys(): void {
    this.validateIdentitySet();

    let attempts = 0;

    while (attempts < SRPClient.MAX_KEY_GENERATION_ATTEMPTS) {
      const randomBits = randomBytes(SRP_PRIVATE_KEY_BITS / 8);
      this._a = bufferToBigInt(randomBits);

      // Ensure key is in valid range without introducing bias
      if (this._a >= this.N) {
        attempts++;
        continue;
      }

      if (this._a === SRPClient.ZERO) {
        attempts++;
        continue;
      }

      this._A = modPow(this.g, this._a, this.N);

      if (this._A <= SRPClient.ONE || this._A >= this.N_MINUS_ONE) {
        attempts++;
        continue;
      }

      // Successfully generated valid keys
      log.debug('Generated client keys successfully');
      return;
    }

    throw new SRPError(
      `Failed to generate secure client keys after ${SRPClient.MAX_KEY_GENERATION_ATTEMPTS} attempts`,
    );
  }

  /**
   * Computes the shared secret S and derives the session key K.
   *
   * @throws {SRPError} If required parameters are not set
   */
  private computeSharedSecret(): void {
    this.validateIdentitySet();

    if (!this._salt || !this._B) {
      throw new SRPError('Salt and server public key must be set first');
    }

    if (this._A === SRPClient.ZERO) {
      throw new SRPError('Client keys not generated');
    }

    const u = calculateU(this._A, this._B, SRP_KEY_LENGTH_BYTES);
    log.debug('Calculated u value');

    const x = calculateX(this._salt, this.username, this.password);
    log.debug('Calculated x value');

    const gx = modPow(this.g, x, this.N);
    const kgx = (this.k * gx) % this.N;

    // Fix negative modulo operation
    let base = this._B - kgx;
    base = ((base % this.N) + this.N) % this.N;

    const exponent = this._a + u * x;
    this._S = modPow(base, exponent, this.N);
    log.debug('Calculated shared secret S');

    const SBuffer = bigIntToBuffer(this._S, SRP_KEY_LENGTH_BYTES);
    this._K = hash(SBuffer);
    log.debug('Calculated session key K');
  }

  /**
   * Validates that identity has been set.
   *
   * @throws {SRPError} If password is not set (username is set by default)
   */
  private validateIdentitySet(): void {
    if (!this.password) {
      throw new SRPError(
        'Password must be set before performing operations. Call setIdentity() first.',
      );
    }
  }

  /**
   * Throws an error if the client has been disposed.
   *
   * @throws {SRPError} If client is disposed
   */
  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new SRPError('SRP client has been disposed');
    }
  }
}
