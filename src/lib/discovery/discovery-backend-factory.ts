import { DevicectlDiscoveryBackend } from './devicectl-discovery-backend.js';
import { DnssdDiscoveryBackend } from './dnssd-discovery-backend.js';
import type { DiscoveryOptions, IDeviceDiscoveryBackend } from './types.js';

export function createDiscoveryBackend(
  platform: NodeJS.Platform = process.platform,
  options?: DiscoveryOptions,
): IDeviceDiscoveryBackend<'dnssd' | 'devicectl'> {
  if (platform === 'darwin') {
    return new DevicectlDiscoveryBackend();
  }
  return new DnssdDiscoveryBackend(options);
}
