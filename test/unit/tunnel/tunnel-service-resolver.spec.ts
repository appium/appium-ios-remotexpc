import { expect } from 'chai';
import esmock from 'esmock';
import { describe, it } from 'node:test';
import * as sinon from 'sinon';

import type { TunnelRegistryEntry } from '../../../src/lib/types.js';

function makeEntry(
  services: TunnelRegistryEntry['services'],
): TunnelRegistryEntry {
  const now = Date.now();
  return {
    udid: 'dev-1',
    deviceId: 1,
    address: 'fd00::1',
    rsdPort: 12_345,
    services,
    connectionType: 'USB',
    productId: 0,
    createdAt: now,
    lastUpdated: now,
  };
}

describe('tunnel-service-resolver', function () {
  it('resolveTunnelService returns host/port from the catalog', async function () {
    const entry = makeEntry({
      'com.apple.afc.shim.remote': { port: '49374' },
    });
    const getTunnelByUdid = sinon.stub().resolves(entry);
    const refreshServiceCatalog = sinon.stub();

    const { resolveTunnelService } = await esmock(
      '../../../src/lib/tunnel/tunnel-service-resolver.js',
      {
        '../../../src/lib/tunnel/tunnel-availability.js': {
          createValidatedStrictRegistryClient: async () => ({
            getTunnelByUdid,
            refreshServiceCatalog,
          }),
          mapEntryToEndpoint: (e: TunnelRegistryEntry) => ({
            host: e.address,
            port: e.rsdPort,
            udid: e.udid,
          }),
        },
      },
    );

    const resolved = await resolveTunnelService(
      'dev-1',
      'com.apple.afc.shim.remote',
    );
    expect(resolved.host).to.equal('fd00::1');
    expect(resolved.port).to.equal(49_374);
    expect(refreshServiceCatalog.called).to.equal(false);
  });

  it('resolveTunnelService refreshes once when the service is missing', async function () {
    const initial = makeEntry({});
    const refreshed = makeEntry({
      'com.apple.dvt.shim.remote': { port: '62078' },
    });
    const getTunnelByUdid = sinon.stub().resolves(initial);
    const refreshServiceCatalog = sinon.stub().resolves(refreshed);

    const { resolveTunnelService } = await esmock(
      '../../../src/lib/tunnel/tunnel-service-resolver.js',
      {
        '../../../src/lib/tunnel/tunnel-availability.js': {
          createValidatedStrictRegistryClient: async () => ({
            getTunnelByUdid,
            refreshServiceCatalog,
          }),
          mapEntryToEndpoint: (e: TunnelRegistryEntry) => ({
            host: e.address,
            port: e.rsdPort,
            udid: e.udid,
          }),
        },
      },
    );

    const resolved = await resolveTunnelService(
      'dev-1',
      'com.apple.dvt.shim.remote',
    );
    expect(refreshServiceCatalog.calledOnceWith('dev-1')).to.equal(true);
    expect(resolved.port).to.equal(62_078);
  });
});
