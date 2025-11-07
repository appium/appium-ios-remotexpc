/** Constants for network protocol */
export const NETWORK_CONSTANTS = {
  MAGIC: 'RPPairing',
  MAGIC_LENGTH: 9,
  HEADER_LENGTH: 11,
  LENGTH_FIELD_SIZE: 2,
  MAX_TLV_FRAGMENT_SIZE: 255,
  PIN_INPUT_TIMEOUT_MS: 30000,
} as const;
