import type { DiscoveredDevice } from '../discovery/types.js';
import type { AppleTVDevice } from './types.js';

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  return undefined;
}

export function toAppleTVDevice(
  device: DiscoveredDevice,
): AppleTVDevice | null {
  const hostname = device.hostname;
  const port = device.port ?? toNumberValue(device.metadata.port);
  if (!hostname || !port) {
    return null;
  }

  const identifier = toStringValue(device.metadata.identifier) || device.id;
  const model = toStringValue(device.metadata.model);
  const version = toStringValue(device.metadata.version);
  const minVersion = toStringValue(device.metadata.minVersion) || '17';
  const authTag = toStringValue(device.metadata.authTag) || undefined;
  const interfaceIndex = toNumberValue(device.metadata.interfaceIndex);

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

export function toAppleTVDevices(devices: DiscoveredDevice[]): AppleTVDevice[] {
  return devices
    .map((device) => toAppleTVDevice(device))
    .filter((device): device is AppleTVDevice => Boolean(device));
}
