import type { DiscoveredDevice } from '../discovery/types.js';
import type { AppleTVDevice } from './types.js';

export function toAppleTVDevice(
  device: DiscoveredDevice,
): AppleTVDevice | null {
  if (!isLikelyAppleTV(device)) {
    return null;
  }

  const hostname = device.hostname;
  const port = device.port;
  if (!hostname || !port) {
    return null;
  }

  const identifier = toStringValue(device.metadata.identifier) || device.id;
  const model = toStringValue(device.metadata.model);
  const version = toStringValue(device.metadata.version);

  return {
    name: device.name,
    identifier,
    hostname,
    ip: device.ip,
    port,
    model,
    version,
  };
}

export function toAppleTVDevices(devices: DiscoveredDevice[]): AppleTVDevice[] {
  return devices
    .map((device) => toAppleTVDevice(device))
    .filter((device): device is AppleTVDevice => Boolean(device));
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isLikelyAppleTV(device: DiscoveredDevice): boolean {
  const deviceType = toStringValue(device.metadata.deviceType).toLowerCase();
  // include all devices if device type is not available
  return deviceType ? deviceType.includes('tv') : true;
}
