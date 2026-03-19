import { Devicectl } from 'node-devicectl';

import { getLogger } from '../logger.js';
import type {
  DevicectlDiscoveryMetadata,
  DiscoveredDevice,
  IDeviceDiscoveryBackend,
} from './types.js';

const log = getLogger('DevicectlDiscoveryBackend');
const DEFAULT_REMOTE_PAIRING_PORT = 49152;
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

function toDiscoveredDevice(
  device: DeviceInfo,
): DiscoveredDevice<'devicectl'> | null {
  const hostname = getPreferredHostname(device);
  if (!hostname) {
    return null;
  }

  const identifier = device.hardwareProperties.udid || device.identifier;
  const metadata: DevicectlDiscoveryMetadata = {
    identifier,
    model: device.hardwareProperties.productType ?? '',
    version: device.deviceProperties.osVersionNumber ?? '',
    deviceType: device.hardwareProperties.deviceType,
    // devicectl does not expose remotepairing service port directly
    port: DEFAULT_REMOTE_PAIRING_PORT,
  };

  return {
    id: identifier,
    name: device.deviceProperties.name,
    hostname,
    ip: device.connectionProperties.tunnelIPAddress,
    source: 'devicectl',
    metadata,
  };
}

export class DevicectlDiscoveryBackend implements IDeviceDiscoveryBackend<'devicectl'> {
  async discoverDevices(
    timeoutMs: number,
  ): Promise<DiscoveredDevice<'devicectl'>[]> {
    void timeoutMs;
    const devicectl = new Devicectl('');
    const devices = await devicectl.listDevices();
    const mapped = devices
      .map((device) => toDiscoveredDevice(device))
      .filter((device): device is DiscoveredDevice<'devicectl'> =>
        Boolean(device),
      );
    if (mapped.length === 0) {
      log.info('No matching devices found via devicectl');
    }
    return mapped;
  }
}
