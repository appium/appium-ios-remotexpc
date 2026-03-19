import { DnssdDiscoveryBackend } from './dnssd-discovery-backend.js';
import type { DiscoveryOptions, IDeviceDiscoveryBackend } from './types.js';

export function createDiscoveryBackend(
  platform: NodeJS.Platform = process.platform,
  options?: DiscoveryOptions,
): IDeviceDiscoveryBackend {
  void platform;
  return new DnssdDiscoveryBackend(options);
}
