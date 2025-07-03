// Default configuration values for Apple TV pairing behavior
export const DEFAULT_PAIRING_CONFIG = {
  timeout: 30000,
  discoveryTimeout: 5000,
  maxRetries: 3,
  pairingDirectory: '.pairing',
} as const;

// TLV8 component type identifiers used in pairing data exchange
export const PairingDataComponentType = {
  METHOD: 0x00,
  IDENTIFIER: 0x01,
  SALT: 0x02,
  PUBLIC_KEY: 0x03,
  PROOF: 0x04,
  ENCRYPTED_DATA: 0x05,
  STATE: 0x06,
  ERROR: 0x07,
  RETRY_DELAY: 0x08,
  CERTIFICATE: 0x09,
  SIGNATURE: 0x0a,
  PERMISSIONS: 0x0b,
  FRAGMENT_DATA: 0x0c,
  FRAGMENT_LAST: 0x0d,
  SESSION_ID: 0x0e,
  TTL: 0x0f,
  EXTRA_DATA: 0x10,
  INFO: 0x11,
  ACL: 0x12,
  FLAGS: 0x13,
  VALIDATION_DATA: 0x14,
  MFI_AUTH_TOKEN: 0x15,
  MFI_PRODUCT_TYPE: 0x16,
  SERIAL_NUMBER: 0x17,
  MFI_AUTH_TOKEN_UUID: 0x18,
  APP_FLAGS: 0x19,
  OWNERSHIP_PROOF: 0x1a,
  SETUP_CODE_TYPE: 0x1b,
  PRODUCTION_DATA: 0x1c,
  APP_INFO: 0x1d,
  SEPARATOR: 0xff,
} as const;

// Maximum allowed size of a TLV8 fragment
export const TLV8_MAX_FRAGMENT_SIZE = 255;

// RFC 5054 3072-bit safe prime used for SRP key exchange
export const SRP_PRIME_3072 = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
    '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
    '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05' +
    '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB' +
    '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
    '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33' +
    'A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864' +
    'D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2' +
    '08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF',
);

// Generator value (g=5) used in SRP key exchange
export const SRP_GENERATOR = BigInt(5);

// Hash algorithm used in SRP protocol (per HomeKit spec)
export const SRP_HASH_ALGORITHM = 'sha512';

// SRP username identifier used in Apple Pair-Setup
export const SRP_USERNAME = 'Pair-Setup';

// Key length in bytes for SRP (3072 bits = 384 bytes)
export const SRP_KEY_LENGTH_BYTES = 384;

// Number of bits for SRP private key (usually 256 bits)
export const SRP_PRIVATE_KEY_BITS = 256;

// Hash algorithm used for HKDF in pairing encryption
export const HKDF_HASH_ALGORITHM = 'sha512';

// Output length (in bytes) for HKDF key derivation
export const HKDF_HASH_LENGTH = 64;

// OPACK2 encoding constants
export const OPACK2_NULL = 0x03;
export const OPACK2_TRUE = 0x01;
export const OPACK2_FALSE = 0x02;
export const OPACK2_SMALL_INT_OFFSET = 8;
export const OPACK2_SMALL_INT_MAX = 0x27;
export const OPACK2_SMALL_STRING_MAX = 0x20;
export const OPACK2_SMALL_BYTES_MAX = 0x20;
export const OPACK2_SMALL_ARRAY_MAX = 15;
export const OPACK2_SMALL_DICT_MAX = 15;

// OPACK2 number type markers
export const OPACK2_INT8_MARKER = 0x30;
export const OPACK2_INT32_MARKER = 0x32;
export const OPACK2_INT64_MARKER = 0x33;
export const OPACK2_FLOAT_MARKER = 0x35;

// OPACK2 string type markers
export const OPACK2_SMALL_STRING_BASE = 0x40;
export const OPACK2_STRING_8BIT_LEN_MARKER = 0x61;
export const OPACK2_STRING_16BIT_LEN_MARKER = 0x62;
export const OPACK2_STRING_32BIT_LEN_MARKER = 0x63;

// OPACK2 bytes type markers
export const OPACK2_SMALL_BYTES_BASE = 0x70;
export const OPACK2_BYTES_8BIT_LEN_MARKER = 0x91;
export const OPACK2_BYTES_16BIT_LEN_MARKER = 0x92;
export const OPACK2_BYTES_32BIT_LEN_MARKER = 0x93;

// OPACK2 array type markers
export const OPACK2_SMALL_ARRAY_BASE = 0xd0;
export const OPACK2_VARIABLE_ARRAY_MARKER = 0xdf;

// OPACK2 dictionary type markers
export const OPACK2_SMALL_DICT_BASE = 0xe0;
export const OPACK2_VARIABLE_DICT_MARKER = 0xef;

// OPACK2 size limits
export const OPACK2_UINT8_MAX = 0xff;
export const OPACK2_UINT16_MAX = 0xffff;
export const OPACK2_UINT32_MAX = 0xffffffff;
