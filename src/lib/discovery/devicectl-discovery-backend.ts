import { Devicectl } from 'node-devicectl';

import { getLogger } from '../logger.js';
import type { DiscoveredDevice, IDeviceDiscoveryBackend } from './types.js';

const log = getLogger('DevicectlDiscoveryBackend');
type DeviceInfo = Awaited<ReturnType<Devicectl['listDevices']>>[number];

function getPreferredHostname(device: DeviceInfo): string | undefined {
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

function toDiscoveredDevice(device: DeviceInfo): DiscoveredDevice | null {
  const platform = device.hardwareProperties.platform?.toLowerCase();
  if (platform !== 'tvos') {
    return null;
  }

  const hostname = getPreferredHostname(device);
  if (!hostname) {
    return null;
  }

  return {
    id: device.identifier,
    name: device.deviceProperties.name,
    hostname,
    ip: device.connectionProperties.tunnelIPAddress,
    source: 'devicectl',
    metadata: {
      identifier: device.identifier,
      model: device.hardwareProperties.productType ?? '',
      version: device.deviceProperties.osVersionNumber ?? '',
      minVersion: '17',
      platform: device.hardwareProperties.platform,
      productType: device.hardwareProperties.productType,
      // devicectl does not expose remotepairing service port directly
      port: 49152,
    },
  };
}

export class DevicectlDiscoveryBackend implements IDeviceDiscoveryBackend {
  async discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]> {
    void timeoutMs;
    const devicectl = new Devicectl('');
    const devices = await devicectl.listDevices();
    const mapped = devices
      .map((device) => toDiscoveredDevice(device))
      .filter((device): device is DiscoveredDevice => Boolean(device));
    if (mapped.length === 0) {
      log.info('No matching devices found via devicectl');
    }
    return mapped;
  }
}
