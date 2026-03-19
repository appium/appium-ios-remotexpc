import {
  Devicectl,
  type DeviceInfo as DevicectlDeviceInfo,
} from 'node-devicectl';

import { getLogger } from '../logger.js';
import type { DiscoveredDeviceMetadata } from './types.js';

const log = getLogger('DevicectlDeviceRecords');
export interface DevicectlDeviceRecord {
  hostname?: string;
  metadata: DiscoveredDeviceMetadata;
}

function getPreferredHostname(device: DevicectlDeviceInfo): string | undefined {
  const hosts = [
    ...(device.connectionProperties.localHostnames ?? []),
    ...device.connectionProperties.potentialHostnames,
  ];
  const host = hosts.find(Boolean);
  if (!host) {
    return undefined;
  }
  return host.endsWith('.') ? host : `${host}.`;
}

function toDevicectlRecord(device: DevicectlDeviceInfo): DevicectlDeviceRecord {
  const hostname = getPreferredHostname(device);
  const identifier = device.hardwareProperties.udid || device.identifier;
  const metadata: DiscoveredDeviceMetadata = {
    identifier,
    model: device.hardwareProperties.productType ?? '',
    version: device.deviceProperties.osVersionNumber ?? '',
    deviceType: device.hardwareProperties.deviceType,
  };
  return {
    hostname,
    metadata,
  };
}

export async function listDevicectlDeviceRecords(): Promise<
  DevicectlDeviceRecord[]
> {
  const devicectl = new Devicectl('');
  const devices = await devicectl.listDevices();
  const records = devices.map((device) => toDevicectlRecord(device));
  if (records.length === 0) {
    log.info('No device records found via devicectl');
  }
  return records;
}
