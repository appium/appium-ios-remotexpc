/**
 * Converts a non-negative bigint to a fixed-length Buffer in big-endian format.
 *
 * @param value - The bigint value to convert (must be non-negative).
 * @param length - The target buffer length in bytes.
 * @returns A Buffer representing the bigint, padded to the specified length.
 *
 * @throws {RangeError} If the value is negative or doesn't fit in the specified length.
 */
export function bigIntToBuffer(value: bigint, length: number): Buffer {
  if (value < 0n) {
    throw new RangeError('Negative values not supported');
  }
  const hex = value.toString(16);
  const byteLength = Math.ceil(hex.length / 2);

  if (byteLength > length) {
    throw new RangeError(
      `Value 0x${hex} is too large to fit in ${length} bytes`,
    );
  }

  const paddedHex = hex.padStart(length * 2, '0');
  return Buffer.from(paddedHex, 'hex');
}

/**
 * Converts a Buffer into a bigint by interpreting it as a big-endian hexadecimal number.
 *
 * @param buffer - The input Buffer.
 * @returns A bigint representing the numeric value of the buffer.
 */
export function bufferToBigInt(buffer: Buffer): bigint {
  return BigInt('0x' + buffer.toString('hex'));
}

/**
 * Converts a non-negative bigint into a minimal-length Buffer in big-endian format.
 * No unnecessary leading zero bytes will be included.
 *
 * @param value - The bigint value to convert (must be non-negative).
 * @returns A Buffer representing the bigint with minimal byte length.
 *
 * @throws {RangeError} If the value is negative.
 */
export function bigIntToMinimalBuffer(value: bigint): Buffer {
  if (value < 0n) {
    throw new RangeError('Negative values not supported');
  }
  const hex = value.toString(16);
  const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
  return Buffer.from(paddedHex, 'hex');
}

/**
 * Computes modular exponentiation: (base ^ exponent) % modulus.
 * Efficiently handles large numbers using the binary exponentiation method.
 *
 * @param base - The base number.
 * @param exponent - The exponent (must be non-negative).
 * @param modulus - The modulus (must be non-zero).
 * @returns The result of (base ** exponent) modulo modulus.
 *
 * @throws {RangeError} If the exponent is negative or the modulus is zero.
 */
export function modPow(
  base: bigint,
  exponent: bigint,
  modulus: bigint,
): bigint {
  if (modulus === 0n) {
    throw new RangeError('Modulus must be non-zero');
  }
  if (exponent < 0n) {
    throw new RangeError('Negative exponents not supported');
  }

  let result = 1n;
  base = base % modulus;

  while (exponent > 0n) {
    if (exponent % 2n === 1n) {
      result = (result * base) % modulus;
    }
    exponent = exponent / 2n;
    base = (base * base) % modulus;
  }

  return result;
}
