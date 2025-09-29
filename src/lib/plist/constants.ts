/**
 * Common constants for plist operations
 */

// Constants for binary plist format
export const BPLIST_MAGIC = 'bplist';
export const BPLIST_VERSION = '00';
export const BPLIST_MAGIC_AND_VERSION = Buffer.from(
  `${BPLIST_MAGIC}${BPLIST_VERSION}`,
);

// Binary plist header constants
export const BINARY_PLIST_MAGIC = 'bplist00';
export const IBINARY_PLIST_MAGIC = 'Ibplist00';
export const BINARY_PLIST_HEADER_LENGTH = 9;

// XML plist constants
export const XML_DECLARATION = '<?xml';
export const PLIST_CLOSING_TAG = '</plist>';

// Length field constants
export const LENGTH_FIELD_1_BYTE = 1;
export const LENGTH_FIELD_2_BYTES = 2;
export const LENGTH_FIELD_4_BYTES = 4;
export const LENGTH_FIELD_8_BYTES = 8;
export const UINT32_HIGH_MULTIPLIER = 0x100000000;

// Encoding constants
export const UTF8_ENCODING = 'utf8';

// Apple epoch offset (seconds between Unix epoch 1970-01-01 and Apple epoch 2001-01-01)
export const APPLE_EPOCH_OFFSET = 978307200;

// Binary plist trailer size (last 32 bytes of the file)
export const BPLIST_TRAILER_SIZE = 32;

// Object types in binary plist
export const BPLIST_TYPE = {
  NULL: 0x00,
  FALSE: 0x08,
  TRUE: 0x09,
  FILL: 0x0f,
  INT: 0x10,
  REAL: 0x20,
  DATE: 0x30,
  DATA: 0x40,
  STRING_ASCII: 0x50,
  STRING_UNICODE: 0x60,
  UID: 0x80,
  ARRAY: 0xa0,
  SET: 0xc0,
  DICT: 0xd0,
};

// Supported file extensions for plist-related file
export const SUPPORTED_EXTENSIONS = [
  '.pem',
  '.cer',
  '.crt',
  '.p12',
  '.pfx',
  '.mobileconfig',
  '.plist',
] as const;
