import type { DiscoveredDevice } from '../discovery/types.js';
import { toRemotePairingDevice } from '../remote-pairing/discovered-device-mapper.js';
import type { RemotePairingDevice } from '../remote-pairing/types.js';

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Heuristic filter for tvOS / Apple TV–oriented discovery (device type metadata).
 * When `deviceType` is missing, all devices are kept (same as historical behavior).
 */
function isLikelyAppleTV(device: DiscoveredDevice): boolean {
  const deviceType = toStringValue(device.metadata.deviceType).toLowerCase();
  return deviceType ? deviceType.includes('tv') : true;
}

/** Map discovery results to pairing targets, keeping only likely Apple TV / tvOS entries. */
export function toAppleTVDevices(
  devices: DiscoveredDevice[],
): RemotePairingDevice[] {
  return devices
    .filter(isLikelyAppleTV)
    .map(toRemotePairingDevice)
    .filter((d): d is RemotePairingDevice => Boolean(d));
}
