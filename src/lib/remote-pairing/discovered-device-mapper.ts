import type { DiscoveredDevice } from '../discovery/types.js';
import type { RemotePairingDevice } from './types.js';

export function toRemotePairingDevice(
  device: DiscoveredDevice,
): RemotePairingDevice | null {
  const hostname = device.hostname;
  const port = device.port;
  if (!hostname || !port) {
    return null;
  }

  const identifier = toStringValue(device.metadata.identifier) || device.id;
  const model = toStringValue(device.metadata.model);
  const version = toStringValue(device.metadata.version);
  const minVersion = toStringValue(device.metadata.minVersion) || '17';
  const authTag = toStringValue(device.metadata.authTag) || undefined;
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

export function toRemotePairingDevices(
  devices: DiscoveredDevice[],
): RemotePairingDevice[] {
  return devices
    .map((device) => toRemotePairingDevice(device))
    .filter((device): device is RemotePairingDevice => Boolean(device));
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
