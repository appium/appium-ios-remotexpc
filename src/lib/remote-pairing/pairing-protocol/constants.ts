/** Constants for pairing protocol states */
export const PAIRING_STATES = {
  M3: 0x03,
  M5: 0x05,
  M6: 0x06,
} as const;

/** Constants for pairing protocol messages */
export const PAIRING_MESSAGES = {
  ENCRYPT_SALT: 'Pair-Setup-Encrypt-Salt',
  ENCRYPT_INFO: 'Pair-Setup-Encrypt-Info',
  SIGN_SALT: 'Pair-Setup-Controller-Sign-Salt',
  SIGN_INFO: 'Pair-Setup-Controller-Sign-Info',
  M5_NONCE: 'PS-Msg05',
  M6_NONCE: 'PS-Msg06',
} as const;

export const PAIR_VERIFY_MESSAGES = {
  ENCRYPT_SALT: 'Pair-Verify-Encrypt-Salt',
  ENCRYPT_INFO: 'Pair-Verify-Encrypt-Info',
  STATE_03_NONCE: 'PV-Msg03',
} as const;

export const PAIR_VERIFY_STATES = {
  STATE_01: 0x01,
  STATE_02: 0x02,
  STATE_03: 0x03,
  STATE_04: 0x04,
} as const;

export const ENCRYPTION_MESSAGES = {
  CLIENT_ENCRYPT: 'ClientEncrypt-main',
  SERVER_ENCRYPT: 'ServerEncrypt-main',
} as const;

/** Error descriptions for pair verification STATE=4 errors */
export const PAIR_VERIFY_ERROR_DESCRIPTIONS: Record<number, string> = {
  1: 'Unknown error',
  2: 'Authentication failed - invalid pair record',
  3: 'Backoff - too many attempts',
  4: 'Max peers - device has too many connections',
  5: 'Max tries exceeded',
  6: 'Service unavailable',
  7: 'Device busy',
} as const;

/** TLV type for device info */
export const INFO_TYPE = 0x11;
