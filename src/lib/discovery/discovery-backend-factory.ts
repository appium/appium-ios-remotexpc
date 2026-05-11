import { BonjourDiscoveryBackend } from './bonjour-discovery-backend.js';
import { DnssdDiscoveryBackend } from './dnssd-discovery-backend.js';
import type { DiscoveryOptions, IDeviceDiscoveryBackend } from './types.js';

/**
 * Create the default device discovery backend for the current platform.
 *
 * On macOS we prefer the system `dns-sd` CLI (Bonjour) because Apple's
 * mDNSResponder advertises non-RFC-6335-compliant service names (e.g.
 * `_remotepairing-manual-pairing._tcp`) that pure-JS mDNS libraries reject.
 *
 * Other platforms fall back to the cross-platform `dnssd` library. Note that
 * `dnssd` enforces RFC 6335 (max 15-char service names), so on Linux/Windows
 * it will not see Apple-style long service names; in those environments
 * callers should advertise/discover via a shorter, compliant service type.
 */
export function createDiscoveryBackend(
  platform: NodeJS.Platform = process.platform,
  options?: DiscoveryOptions,
): IDeviceDiscoveryBackend {
  if (platform === 'darwin') {
    return new BonjourDiscoveryBackend(options);
  }
  return new DnssdDiscoveryBackend(options);
}
