import {
  Devicectl,
  type DeviceInfo as DevicectlDeviceInfo,
} from 'node-devicectl';

import { getLogger } from '../logger.js';

const log = getLogger('DevicectlDeviceRecords');

export interface DevicectlDeviceRecord {
  hostnames: string[];
  identifier?: string;
  model?: string;
  version?: string;
  deviceType?: string;
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

function getHostnames(device: DevicectlDeviceInfo): string[] {
  const hosts = [
    ...(device.connectionProperties.localHostnames ?? []),
    ...device.connectionProperties.potentialHostnames,
  ];
  const normalized = hosts
    .filter((host): host is string => Boolean(host))
    .map((host) => (host.endsWith('.') ? host : `${host}.`));
  return Array.from(new Set(normalized));
}

function toDevicectlRecord(device: DevicectlDeviceInfo): DevicectlDeviceRecord {
  return {
    hostnames: getHostnames(device),
    identifier: device.hardwareProperties.udid,
    model: device.hardwareProperties.productType ?? '',
    version: device.deviceProperties.osVersionNumber ?? '',
    deviceType: device.hardwareProperties.deviceType,
  };
}
