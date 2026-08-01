import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import esmock from 'esmock';

import type {DevicectlDeviceRecord} from '../../../src/lib/discovery/devicectl-device-records.js';
import type {DiscoveredDevice} from '../../../src/lib/discovery/types.js';

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
    const mod = await esmock('../../../src/lib/apple-tv/devicectl-enrichment.js', import.meta.url, {
      '../../../src/lib/discovery/devicectl-device-records.js': {
        listDevicectlDeviceRecords: async () => records,
      },
    });
    return mod.enrichDiscoveredDevicesWithDevicectl as (devices: DiscoveredDevice[]) => Promise<DiscoveredDevice[]>;
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
        },
      },
    ];
    const records: DevicectlDeviceRecord[] = [
      {
        hostnames: ['sample-device.coredevice.local', 'sample-device.local'],
        identifier: 'udid-123',
        model: 'AppleTV6,2',
        version: '17.4',
        deviceType: 'tv',
      },
    ];

    const enrichDiscoveredDevicesWithDevicectl = await loadEnricher(records);
    const enriched = await enrichDiscoveredDevicesWithDevicectl(devices);

    assert.strictEqual(enriched.length, 1);
    assert.strictEqual(enriched[0].metadata.identifier, 'udid-123');
    assert.strictEqual(enriched[0].metadata.identifierSource, 'devicectl');
    assert.strictEqual(enriched[0].metadata.model, 'AppleTV6,2');
    assert.strictEqual(enriched[0].metadata.version, '17.4');
    assert.strictEqual(enriched[0].metadata.deviceType, 'tv');
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
        hostnames: ['kitchen.coredevice.local'],
        identifier: 'udid-456',
        model: 'AppleTV11,1',
        version: '18.0',
        deviceType: 'tv',
      },
    ];

    const enrichDiscoveredDevicesWithDevicectl = await loadEnricher(records);
    const enriched = await enrichDiscoveredDevicesWithDevicectl(devices);

    assert.deepStrictEqual(enriched, devices);
  });
});
