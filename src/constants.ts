// Global constants used across the appium-ios-remotexpc package

// Strongbox container name for storing credentials and configuration
export const STRONGBOX_CONTAINER_NAME = 'appium-ios-remotexpc';

// Strongbox container name for tunnel registry port
export const TUNNEL_CONTAINER_NAME = 'appium-xcuitest-driver';

// Strongbox item name prefixes (must not overlap)
export const PAIR_RECORD_ITEM_PREFIX = 'pair_record_';
/** @deprecated Use REMOTE_PAIRING_PREFIX for new records; kept for backward compatibility */
export const APPLETV_PAIRING_PREFIX = 'appletv_pairing_';
/** Preferred prefix for Remote Pairing credentials (iOS, iPadOS, tvOS, etc.) */
export const REMOTE_PAIRING_PREFIX = 'remote_pairing_';
