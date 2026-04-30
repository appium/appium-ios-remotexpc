import { listDevicectlDeviceRecords } from '../discovery/devicectl-device-records.js';
import type { DevicectlDeviceRecord } from '../discovery/devicectl-device-records.js';
import type { DiscoveredDevice } from '../discovery/types.js';

/**
 * Enrich discovered devices with metadata retrieved from `devicectl`.
 */
export async function enrichDiscoveredDevicesWithDevicectl(
  devices: DiscoveredDevice[],
): Promise<DiscoveredDevice[]> {
  if (process.platform !== 'darwin' || devices.length === 0) {
    return devices;
  }

  const records = await listDevicectlDeviceRecords();
  if (records.length === 0) {
    return devices;
  }

  const byHost = records.reduce<Map<string, (typeof records)[0]>>(
    (acc, record) => {
      for (const hostname of record.hostnames) {
        for (const key of hostMatchingKeys(hostname)) {
          if (!acc.has(key)) {
            acc.set(key, record);
          }
        }
      }
      return acc;
    },
    new Map<string, (typeof records)[0]>(),
  );

  return devices.map((device) => {
    const match = hostMatchingKeys(device.hostname)
      .map((key) => byHost.get(key))
      .find(Boolean);
    if (!match) {
      return device;
    }
    return {
      ...device,
      metadata: mergeMetadata(device.metadata, match),
    };
  });
}

/**
 * Normalize hostname for case-insensitive comparison and keying.
 */
function normalizeHost(host?: string): string | undefined {
  if (!host) {
    return undefined;
  }
  return host.replace(/\.$/, '').toLowerCase();
}

/**
 * Generate candidate lookup keys for matching hostnames.
 */
function hostMatchingKeys(host?: string): string[] {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return [];
  }
  const keys = new Set<string>([normalized]);
  const short = normalized.split('.')[0];
  if (short) {
    keys.add(short);
  }
  return Array.from(keys);
}

/**
 * Merge `devicectl` metadata into existing discovered device metadata.
 */
function mergeMetadata(
  base: DiscoveredDevice['metadata'],
  extra: DevicectlDeviceRecord,
): DiscoveredDevice['metadata'] {
  return {
    ...base,
    identifier: extra.identifier || base.identifier,
    model: extra.model || base.model,
    version: extra.version || base.version,
    deviceType: extra.deviceType || base.deviceType,
  };
}
