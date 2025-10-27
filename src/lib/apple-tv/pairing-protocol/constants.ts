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

/** TLV type for device info */
export const INFO_TYPE = 0x11;
