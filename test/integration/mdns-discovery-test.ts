import { logger } from '@appium/support';

import { REMOTE_PAIRING_MANUAL_DISCOVERY_SERVICE_TYPE } from '../../src/lib/apple-tv/constants.js';
import { createDiscoveryBackend } from '../../src/lib/discovery/discovery-backend-factory.js';
import { MdnsTestResponder } from '../helpers/mdns-test-responder.js';

const log = logger.getLogger('MdnsDiscoveryTest');

const TEST_SERVICE_TYPE = '_apptest-remotexpc._tcp';
const DISCOVERY_TIMEOUT_MS = 3000;

describe('mDNS discovery (e2e)', function () {
  this.timeout(15000);

  let responder: MdnsTestResponder | undefined;
  let bindError: Error | undefined;

  before(async function () {
    try {
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
          txt: { identifier: 'e2e-long-id' },
        },
      ]);
    } catch (err) {
      bindError = err instanceof Error ? err : new Error(String(err));
    }
    if (bindError) {
      log.warn(
        `Skipping mDNS e2e: cannot bind UDP port 5353 (${bindError.message})`,
      );
      this.skip();
    }
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

    expect(devices).to.have.lengthOf(1);
    const device = devices[0]!;
    expect(device.name).to.equal('E2E Test Device');
    expect(device.id).to.equal('e2e-test-id');
    expect(device.hostname).to.equal('apptest-host.local.');
    expect(device.port).to.equal(49152);
    expect(device.ip).to.equal('127.0.0.1');
    expect(device.metadata).to.deep.include({
      identifier: 'e2e-test-id',
      model: 'AppleTV6,2',
      version: '18.0',
    });
  });

  it('discovers non-RFC-6335 long Apple-style service names', async function () {
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: REMOTE_PAIRING_MANUAL_DISCOVERY_SERVICE_TYPE,
      domain: 'local',
    });
    const devices = await backend.discoverDevices(DISCOVERY_TIMEOUT_MS);

    expect(devices).to.have.lengthOf(1);
    const device = devices[0]!;
    expect(device.name).to.equal('E2E Long Service');
    expect(device.id).to.equal('e2e-long-id');
    expect(device.port).to.equal(49153);
    expect(device.ip).to.equal('127.0.0.1');
  });
});

describe('mDNS discovery (live _remotepairing._tcp on LAN)', function () {
  this.timeout(30000);

  const enabled = process.env.REMOTE_PAIRING_LIVE_DISCOVERY === '1';

  before(function () {
    if (!enabled) {
      this.skip();
    }
  });

  it('discovers at least one Apple device advertising _remotepairing._tcp', async function () {
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: '_remotepairing._tcp',
      domain: 'local',
    });
    const devices = await backend.discoverDevices(10000);
    expect(devices.length).to.be.greaterThan(
      0,
      'No _remotepairing._tcp advertisers found on the LAN — Macs and other paired Apple devices count',
    );
  });
});
