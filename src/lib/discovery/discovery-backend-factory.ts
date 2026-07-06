import {MdnsDiscoveryBackend} from './mdns-discovery-backend.js';
import type {DiscoveryOptions, IDeviceDiscoveryBackend} from './types.js';

/**
 * Create the default device discovery backend for the current platform.
 *
 * Uses a raw mDNS browser on UDP port 5353 so Apple's non-RFC-6335 service
 * names (e.g. `_remotepairing-manual-pairing._tcp`) work on macOS, Linux,
 * and Windows without the macOS `dns-sd` CLI or the `dnssd` npm package.
 */
export function createDiscoveryBackend(
  platform: NodeJS.Platform = process.platform,
  options?: DiscoveryOptions,
): IDeviceDiscoveryBackend {
  void platform;
  return new MdnsDiscoveryBackend(options);
}
