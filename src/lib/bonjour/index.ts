import { type AppleTVDevice, BonjourDiscovery } from './bonjour-discovery.js';

export {
  BONJOUR_TIMEOUTS,
  BONJOUR_SERVICE_TYPES,
  BONJOUR_DEFAULT_DOMAIN,
} from './constants.js';

/**
 * Create a new Bonjour discovery instance
 */
export function createBonjourDiscovery(): BonjourDiscovery {
  return new BonjourDiscovery();
}

/**
 * Discover Apple TV devices using Bonjour with IP address resolution
 * @param timeoutMs - Discovery timeout in milliseconds (default: 5000)
 * @returns Promise that resolves to an array of discovered Apple TV devices with resolved IP addresses
 */
export async function discoverAppleTVDevicesWithIP(
  timeoutMs: number = 5000,
): Promise<AppleTVDevice[]> {
  const discovery = createBonjourDiscovery();
  return discovery.discoverAppleTVDevicesWithIP(timeoutMs);
}
