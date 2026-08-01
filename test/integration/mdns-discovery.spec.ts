import assert from 'node:assert/strict';
import {type TestContext, after, before, describe, it} from 'node:test';

import {REMOTE_PAIRING_MANUAL_DISCOVERY_SERVICE_TYPE} from '../../src/lib/apple-tv/constants.js';
import {createDiscoveryBackend} from '../../src/lib/discovery/discovery-backend-factory.js';
import {MdnsTestResponder} from '../helpers/mdns-test-responder.js';

const TEST_SERVICE_TYPE = '_apptest-remotexpc._tcp';
const DISCOVERY_TIMEOUT_MS = 3000;

describe('mDNS discovery (e2e)', {timeout: 15000}, function () {
  let responder: MdnsTestResponder | undefined;

  before(async function () {
    responder = await MdnsTestResponder.start([
      {
        instanceName: 'E2E Test Device',
        serviceType: TEST_SERVICE_TYPE,
        host: 'apptest-host.local.',
        port: 49152,
        ipv4: '127.0.0.1',
        txt: {
          identifier: 'e2e-test-id',
          model: 'AppleTV6,2',
          ver: '18.0',
        },
      },
      {
        instanceName: 'E2E Long Service',
        serviceType: REMOTE_PAIRING_MANUAL_DISCOVERY_SERVICE_TYPE,
        host: 'apptest-long.local.',
        port: 49153,
        ipv4: '127.0.0.1',
        txt: {identifier: 'e2e-long-id'},
      },
    ]);
  });

  after(async function () {
    await responder?.stop();
  });

  it('discovers a fixture-advertised service via MdnsDiscoveryBackend', async function () {
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: TEST_SERVICE_TYPE,
      domain: 'local',
    });
    const devices = await backend.discoverDevices(DISCOVERY_TIMEOUT_MS);

    assert.strictEqual(devices.length, 1);
    const device = devices[0]!;
    assert.strictEqual(device.name, 'E2E Test Device');
    assert.strictEqual(device.id, 'e2e-test-id');
    assert.strictEqual(device.hostname, 'apptest-host.local.');
    assert.strictEqual(device.port, 49152);
    assert.strictEqual(device.ip, '127.0.0.1');
    const expectedMetadata = {
      identifier: 'e2e-test-id',
      model: 'AppleTV6,2',
      version: '18.0',
    };
    assert.deepStrictEqual(
      Object.fromEntries(Object.keys(expectedMetadata).map((k) => [k, (device.metadata as any)[k]])),
      expectedMetadata,
    );
  });

  it('discovers non-RFC-6335 long Apple-style service names', async function () {
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: REMOTE_PAIRING_MANUAL_DISCOVERY_SERVICE_TYPE,
      domain: 'local',
    });
    const devices = await backend.discoverDevices(DISCOVERY_TIMEOUT_MS);

    assert.strictEqual(devices.length, 1);
    const device = devices[0]!;
    assert.strictEqual(device.name, 'E2E Long Service');
    assert.strictEqual(device.id, 'e2e-long-id');
    assert.strictEqual(device.port, 49153);
    assert.strictEqual(device.ip, '127.0.0.1');
  });
});

describe('mDNS discovery (live _remotepairing._tcp on LAN)', {timeout: 30000}, function () {
  const enabled = process.env.REMOTE_PAIRING_LIVE_DISCOVERY === '1';

  it('discovers at least one Apple device advertising _remotepairing._tcp', async function (ctx: TestContext) {
    if (!enabled) {
      ctx.skip();
      return;
    }
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: '_remotepairing._tcp',
      domain: 'local',
    });
    const devices = await backend.discoverDevices(10000);
    assert.ok(
      devices.length > 0,
      'No _remotepairing._tcp advertisers found on the LAN — Macs and other paired Apple devices count',
    );
  });
});
