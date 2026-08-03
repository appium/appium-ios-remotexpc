import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {TestContext} from 'node:test';

import * as sinon from 'sinon';

import type {AppleTVDevice} from '../../../src/lib/apple-tv/types.js';
import type {DiscoveredDevice} from '../../../src/lib/discovery/types.js';
import {mockImport} from '../../helpers/mock-module.js';

describe('AppleTVTunnelService', function () {
  async function loadTunnelService(t: TestContext) {
    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
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
    return AppleTVTunnelService;
  }

  it('uses the provided device discovery timeout', async function (t) {
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

    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/discovery/discovery-backend-factory.js': {
          createDiscoveryBackend: () => ({discoverDevices}),
        },
        '../../../src/lib/apple-tv/devicectl-enrichment.js': {
          enrichDiscoveredDevicesWithDevicectl: async (discoveredDevices: DiscoveredDevice[]) => discoveredDevices,
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

    assert.deepStrictEqual(discovered, devices);
    assert.strictEqual(discoverDevices.calledOnceWithExactly(20_000), true);
  });

  it('uses provided devices without running discovery', async function (t) {
    const discoverDevices = sinon.stub().rejects(new Error('unexpected discovery'));
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

    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/discovery/discovery-backend-factory.js': {
          createDiscoveryBackend: () => ({discoverDevices}),
        },
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {
            async getAvailableDeviceIds(): Promise<string[]> {
              return [];
            }
          },
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            resume() {}
          },
        },
      },
    );

    const tunnelService = new AppleTVTunnelService();
    let error: Error | undefined;
    try {
      await tunnelService.startTunnel(undefined, undefined, {devices});
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(error?.message, 'No pair records found');
    assert.strictEqual(discoverDevices.called, false);
  });

  it('uses remotePairingUdid from the pair record as the tunnel identifier', async function (t) {
    const AppleTVTunnelService = await loadTunnelService(t);
    const tunnelService = new AppleTVTunnelService();
    const device: AppleTVDevice = {
      name: 'Apple TV',
      identifier: 'devicectl-udid',
      identifierSource: 'devicectl',
      hostname: 'apple-tv.local',
      port: 49152,
      model: 'AppleTV',
      version: '17.0',
    };

    const tunnelDevice = (tunnelService as any).withTunnelIdentifier(device, {
      publicKey: Buffer.alloc(0),
      privateKey: Buffer.alloc(0),
      remoteUnlockHostKey: '',
      remotePairingUdid: 'synthetic-remote-pairing-udid',
    });

    assert.strictEqual(tunnelDevice.identifier, 'SYNTHETIC-REMOTE-PAIRING-UDID');
  });

  it('falls back to devicectl identifiers only on macOS', async function (t) {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    try {
      const AppleTVTunnelService = await loadTunnelService(t);
      const tunnelService = new AppleTVTunnelService();
      const device: AppleTVDevice = {
        name: 'Apple TV',
        identifier: 'synthetic-devicectl-udid',
        identifierSource: 'devicectl',
        hostname: 'apple-tv.local',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      };

      const tunnelDevice = (tunnelService as any).withTunnelIdentifier(device, {
        publicKey: Buffer.alloc(0),
        privateKey: Buffer.alloc(0),
        remoteUnlockHostKey: '',
      });

      assert.strictEqual(tunnelDevice.identifier, 'SYNTHETIC-DEVICECTL-UDID');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('throws if no remotePairingUdid or macOS devicectl fallback is available', async function (t) {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const AppleTVTunnelService = await loadTunnelService(t);
      const tunnelService = new AppleTVTunnelService();
      const device: AppleTVDevice = {
        name: 'Apple TV',
        identifier: 'bonjour-id',
        identifierSource: 'bonjour',
        hostname: 'apple-tv.local',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      };

      assert.throws(
        () =>
          (tunnelService as any).withTunnelIdentifier(device, {
            publicKey: Buffer.alloc(0),
            privateKey: Buffer.alloc(0),
            remoteUnlockHostKey: '',
          }),
        (err: any) =>
          err.message.includes(
            'Pair record does not include remote_pairing_udid and no macOS devicectl fallback is available',
          ),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
