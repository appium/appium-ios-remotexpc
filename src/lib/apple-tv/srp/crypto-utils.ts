import { createHash } from 'node:crypto';

import { SRP_HASH_ALGORITHM } from '../constants.js';
import {
  bigIntToBuffer,
  bigIntToMinimalBuffer,
  bufferToBigInt,
} from '../utils/buffer-utils.js';

/**
 * Computes a cryptographic hash of the provided input buffers.
 *
 * @param inputs - Variable number of Buffer objects to hash
 * @returns The computed hash as a Buffer
 * @throws {Error} If no inputs provided
 */
export function hash(...inputs: Buffer[]): Buffer {
  if (inputs.length === 0) {
    throw new Error('At least one input buffer is required for hashing');
  }

  const hasher = createHash(SRP_HASH_ALGORITHM);

  for (const input of inputs) {
    if (!Buffer.isBuffer(input)) {
      throw new Error('All inputs must be Buffer objects');
    }
    hasher.update(input);
  }

  return hasher.digest();
}

/**
 * Calculates the SRP multiplier parameter k = H(N, g).
 *
 * @param N - The large safe prime modulus
 * @param g - The generator
 * @param keyLength - The key length in bytes
 * @returns The calculated k value as a bigint
 * @throws {Error} If parameters are invalid
 */
export function calculateK(N: bigint, g: bigint, keyLength: number): bigint {
  if (N <= BigInt(0) || g <= BigInt(0)) {
    throw new Error('N and g must be positive');
  }
  if (keyLength <= 0) {
    throw new Error('Key length must be positive');
  }

  const NBuffer = bigIntToBuffer(N, keyLength);
  const gBuffer = bigIntToBuffer(g, keyLength);
  const kHash = hash(NBuffer, gBuffer);

  return bufferToBigInt(kHash);
}

/**
 * Calculates the private key x = H(salt, H(username:password)).
 *
 * @param salt - The salt buffer
 * @param username - The username string
 * @param password - The password string
 * @returns The calculated x value as a bigint
 * @throws {Error} If parameters are invalid
 */
export function calculateX(
  salt: Buffer,
  username: string,
  password: string,
): bigint {
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new Error('Salt must be a non-empty Buffer');
  }
  if (!username || !password) {
    throw new Error('Username and password must be non-empty strings');
  }

  const usernamePasswordHash = hash(
    Buffer.from(`${username}:${password}`, 'utf8'),
  );
  const xHash = hash(salt, usernamePasswordHash);

  return bufferToBigInt(xHash);
}

/**
 * Calculates the random scrambling parameter u = H(A, B).
 *
 * @param A - The client's public key
 * @param B - The server's public key
 * @param keyLength - The key length in bytes
 * @returns The calculated u value as a bigint
 * @throws {Error} If parameters are invalid
 */
export function calculateU(A: bigint, B: bigint, keyLength: number): bigint {
  if (A <= BigInt(0) || B <= BigInt(0)) {
    throw new Error('Public keys A and B must be positive');
  }
  if (keyLength <= 0) {
    throw new Error('Key length must be positive');
  }

  const ABuffer = bigIntToBuffer(A, keyLength);
  const BBuffer = bigIntToBuffer(B, keyLength);
  const uHash = hash(ABuffer, BBuffer);

  const u = bufferToBigInt(uHash);
  if (u === BigInt(0)) {
    throw new Error('Calculated u value cannot be zero (hash collision)');
  }

  return u;
}

/**
 * Calculates the client evidence M1 = H(H(N) xor H(g), H(username), salt, A, B, K).
 *
 * @param N - The large safe prime modulus
 * @param g - The generator
 * @param username - The username string
 * @param salt - The salt buffer
 * @param A - The client's public key
 * @param B - The server's public key
 * @param K - The session key
 * @returns The calculated M1 evidence as a Buffer
 * @throws {Error} If parameters are invalid
 */
export function calculateM1(
  N: bigint,
  g: bigint,
  username: string,
  salt: Buffer,
  A: bigint,
  B: bigint,
  K: Buffer,
): Buffer {
  if (N <= BigInt(0) || g <= BigInt(0) || A <= BigInt(0) || B <= BigInt(0)) {
    throw new Error('All bigint parameters must be positive');
  }
  if (!username) {
    throw new Error('Username must be non-empty');
  }
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new Error('Salt must be a non-empty Buffer');
  }
  if (!Buffer.isBuffer(K) || K.length === 0) {
    throw new Error('Session key K must be a non-empty Buffer');
  }

  const NBytes = bigIntToMinimalBuffer(N);
  const gBytes = bigIntToMinimalBuffer(g);
  const NHash = hash(NBytes);
  const gHash = hash(gBytes);

  const NgXorBytes = Buffer.alloc(NHash.length);
  for (let i = 0; i < NHash.length; i++) {
    NgXorBytes[i] = NHash[i] ^ gHash[i];
  }

  const usernameHash = hash(Buffer.from(username, 'utf8'));
  const ABytes = bigIntToMinimalBuffer(A);
  const BBytes = bigIntToMinimalBuffer(B);

  return hash(NgXorBytes, usernameHash, salt, ABytes, BBytes, K);
}
