import { expect } from 'chai';
import esmock from 'esmock';
import * as sinon from 'sinon';

import type { AppleTVDevice } from '../../../src/lib/apple-tv/types.js';
import type { DiscoveredDevice } from '../../../src/lib/discovery/types.js';

describe('AppleTVTunnelService', function () {
  it('uses the provided device discovery timeout', async function () {
    const discoverDevices = sinon.stub().resolves([
      {
        id: 'device-1',
        name: 'Apple TV',
        hostname: 'apple-tv.local',
        ip: '192.168.1.10',
        port: 49152,
        metadata: {
          identifier: 'device-1',
          model: 'AppleTV',
          version: '17.0',
        },
      },
    ] satisfies DiscoveredDevice[]);
    const devices: AppleTVDevice[] = [
      {
        name: 'Apple TV',
        identifier: 'device-1',
        hostname: 'apple-tv.local',
        ip: '192.168.1.10',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      },
    ];

    const { AppleTVTunnelService } = await esmock(
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      {
        '../../../src/lib/discovery/discovery-backend-factory.js': {
          createDiscoveryBackend: () => ({ discoverDevices }),
        },
        '../../../src/lib/apple-tv/devicectl-enrichment.js': {
          enrichDiscoveredDevicesWithDevicectl: async (
            discoveredDevices: DiscoveredDevice[],
          ) => discoveredDevices,
        },
        '../../../src/lib/apple-tv/discovered-device-mapper.js': {
          toAppleTVDevices: () => devices,
        },
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {},
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            resume() {}
          },
        },
      },
    );

    const tunnelService = new AppleTVTunnelService();
    const discovered = await tunnelService.discoverDevices({
      timeoutMs: 20_000,
    });

    expect(discovered).to.deep.equal(devices);
    expect(discoverDevices.calledOnceWithExactly(20_000)).to.equal(true);
  });
});
