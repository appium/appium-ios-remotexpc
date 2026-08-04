import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import * as sinon from 'sinon';

import type {TunnelRegistryEntry} from '../../../src/lib/types.js';
import {mockImport} from '../../helpers/mock-module.js';

function makeEntry(services: TunnelRegistryEntry['services']): TunnelRegistryEntry {
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
  it('resolveTunnelService returns host/port from the catalog', async function (t) {
    const entry = makeEntry({
      'com.apple.afc.shim.remote': {port: '49374'},
    });
    const getTunnelByUdid = sinon.stub().resolves(entry);
    const refreshServiceCatalog = sinon.stub();

    const {resolveTunnelService} = await mockImport(
      t,
      '../../../src/lib/tunnel/tunnel-service-resolver.js',
      import.meta.url,
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

    const resolved = await resolveTunnelService('dev-1', 'com.apple.afc.shim.remote');
    assert.strictEqual(resolved.host, 'fd00::1');
    assert.strictEqual(resolved.port, 49_374);
    assert.strictEqual(refreshServiceCatalog.called, false);
  });

  it('resolveTunnelService refreshes once when the service is missing', async function (t) {
    const initial = makeEntry({});
    const refreshed = makeEntry({
      'com.apple.dvt.shim.remote': {port: '62078'},
    });
    const getTunnelByUdid = sinon.stub().resolves(initial);
    const refreshServiceCatalog = sinon.stub().resolves(refreshed);

    const {resolveTunnelService} = await mockImport(
      t,
      '../../../src/lib/tunnel/tunnel-service-resolver.js',
      import.meta.url,
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

    const resolved = await resolveTunnelService('dev-1', 'com.apple.dvt.shim.remote');
    assert.strictEqual(refreshServiceCatalog.calledOnceWith('dev-1'), true);
    assert.strictEqual(resolved.port, 62_078);
  });
});
