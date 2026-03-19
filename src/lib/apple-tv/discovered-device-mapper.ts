import type { AnyDiscoveredDevice } from '../discovery/types.js';
import type { AppleTVDevice } from './types.js';

export function toAppleTVDevice(
  device: AnyDiscoveredDevice,
): AppleTVDevice | null {
  if (!isLikelyAppleTV(device)) {
    return null;
  }

  const hostname = device.hostname;
  const port =
    device.port ??
    (device.source === 'devicectl'
      ? toNumberValue(device.metadata.port)
      : undefined);
  if (!hostname || !port) {
    return null;
  }

  const identifier = toStringValue(device.metadata.identifier) || device.id;
  const model = toStringValue(device.metadata.model);
  const version = toStringValue(device.metadata.version);
  const minVersion =
    device.source === 'dnssd'
      ? toStringValue(device.metadata.minVersion) || '17'
      : '17';
  const authTag =
    device.source === 'dnssd'
      ? toStringValue(device.metadata.authTag) || undefined
      : undefined;
  const interfaceIndex: number | undefined = undefined;

  return {
    name: device.name,
    identifier,
    hostname,
    ip: device.ip,
    port,
    model,
    version,
    minVersion,
    authTag,
    interfaceIndex,
  };
}

export function toAppleTVDevices(
  devices: AnyDiscoveredDevice[],
): AppleTVDevice[] {
  return devices
    .map((device) => toAppleTVDevice(device))
    .filter((device): device is AppleTVDevice => Boolean(device));
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  return undefined;
}

function isLikelyAppleTV(device: AnyDiscoveredDevice): boolean {
  if (device.source !== 'devicectl') {
    // include all devices if source metadata doesn't define deviceType
    return true;
  }
  const deviceType = toStringValue(device.metadata.deviceType).toLowerCase();
  // include all devices if device type is not available
  return deviceType ? deviceType.includes('tv') : true;
}
