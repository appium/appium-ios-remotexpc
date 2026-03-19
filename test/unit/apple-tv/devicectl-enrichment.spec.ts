import { expect } from 'chai';
import esmock from 'esmock';

import type { DevicectlDeviceRecord } from '../../../src/lib/discovery/devicectl-device-records.js';
import type { DiscoveredDevice } from '../../../src/lib/discovery/types.js';

describe('devicectl-enrichment', function () {
  const originalPlatform = process.platform;

  beforeEach(function () {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  afterEach(function () {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  async function loadEnricher(records: DevicectlDeviceRecord[]) {
    const mod = await esmock(
      '../../../src/lib/apple-tv/devicectl-enrichment.js',
      {
        '../../../src/lib/discovery/devicectl-device-records.js': {
          listDevicectlDeviceRecords: async () => records,
        },
      },
    );
    return mod.enrichDiscoveredDevicesWithDevicectl as (
      devices: DiscoveredDevice[],
    ) => Promise<DiscoveredDevice[]>;
  }

  it('matches dnssd .local hostname to devicectl .coredevice.local', async function () {
    const devices: DiscoveredDevice[] = [
      {
        id: 'device-1',
        name: 'Apple TV',
        hostname: 'sample-device.local.',
        ip: '192.168.1.10',
        port: 49152,
        metadata: {
          identifier: 'dnssd-id',
          model: '',
          version: '',
          deviceType: '',
          minVersion: '17',
          authTag: 'base-auth-tag',
          serviceType: '_remotepairing._tcp',
        },
      },
    ];
    const records: DevicectlDeviceRecord[] = [
      {
        hostname: 'sample-device.coredevice.local',
        metadata: {
          identifier: 'udid-123',
          model: 'AppleTV6,2',
          version: '17.4',
          deviceType: 'tv',
        },
      },
    ];

    const enrichDiscoveredDevicesWithDevicectl = await loadEnricher(records);
    const enriched = await enrichDiscoveredDevicesWithDevicectl(devices);

    expect(enriched).to.have.lengthOf(1);
    expect(enriched[0].metadata.identifier).to.equal('udid-123');
    expect(enriched[0].metadata.model).to.equal('AppleTV6,2');
    expect(enriched[0].metadata.version).to.equal('17.4');
    expect(enriched[0].metadata.deviceType).to.equal('tv');
    expect(enriched[0].metadata.minVersion).to.equal('17');
    expect(enriched[0].metadata.authTag).to.equal('base-auth-tag');
    expect(enriched[0].metadata.serviceType).to.equal('_remotepairing._tcp');
  });

  it('keeps device unchanged when hostnames do not match', async function () {
    const devices: DiscoveredDevice[] = [
      {
        id: 'device-1',
        name: 'Apple TV',
        hostname: 'living-room.local.',
        ip: '192.168.1.20',
        port: 49152,
        metadata: {
          identifier: 'dnssd-id',
        },
      },
    ];
    const records: DevicectlDeviceRecord[] = [
      {
        hostname: 'kitchen.coredevice.local',
        metadata: {
          identifier: 'udid-456',
          model: 'AppleTV11,1',
          version: '18.0',
          deviceType: 'tv',
        },
      },
    ];

    const enrichDiscoveredDevicesWithDevicectl = await loadEnricher(records);
    const enriched = await enrichDiscoveredDevicesWithDevicectl(devices);

    expect(enriched).to.deep.equal(devices);
  });
});
