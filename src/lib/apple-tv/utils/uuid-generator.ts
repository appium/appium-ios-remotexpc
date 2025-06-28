import { createHash } from 'node:crypto';

// UUID namespace for DNS, per RFC 4122
const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Generates a deterministic UUIDv3 (MD5-based) from a hostname string.
 * This mimics DNS-based UUID generation using the standard DNS namespace UUID.
 *
 * @param hostname - The host string to be converted to a UUID
 * @returns A UUIDv3 string in uppercase
 */
export function generateHostId(hostname: string): string {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new TypeError('Hostname must be a non-empty string');
  }
  const namespaceBytes = Buffer.from(NAMESPACE_DNS.replace(/-/g, ''), 'hex');

  // Hash the namespace and the hostname using MD5
  const hash = createHash('md5');
  hash.update(namespaceBytes);
  hash.update(hostname, 'utf8');
  const hashBytes = hash.digest();

  // Set UUID version to 3 (MD5)
  hashBytes[6] = (hashBytes[6] & 0x0f) | 0x30;

  // Set UUID variant to RFC 4122
  hashBytes[8] = (hashBytes[8] & 0x3f) | 0x80;

  // Convert to UUID string format
  const uuid = [
    hashBytes.subarray(0, 4).toString('hex'),
    hashBytes.subarray(4, 6).toString('hex'),
    hashBytes.subarray(6, 8).toString('hex'),
    hashBytes.subarray(8, 10).toString('hex'),
    hashBytes.subarray(10, 16).toString('hex'),
  ]
    .join('-')
    .toUpperCase();

  return uuid;
}
