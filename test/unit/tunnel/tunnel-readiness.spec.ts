import {describe, it} from 'node:test';

import {expect} from 'chai';

import {TunnelReadinessCoordinator} from '../../../src/lib/tunnel/tunnel-readiness.js';
import type {TunnelRegistryEntry} from '../../../src/lib/types.js';

function makeEntry(udid: string): TunnelRegistryEntry {
  const now = Date.now();
  return {
    udid,
    deviceId: 1,
    address: 'fd00::1',
    rsdPort: 12_345,
    services: {'com.apple.test': {port: '1'}},
    connectionType: 'USB',
    productId: 0,
    createdAt: now,
    lastUpdated: now,
  };
}

describe('TunnelReadinessCoordinator', function () {
  it('resolves waiters when resolveReady is called', async function () {
    const coordinator = new TunnelReadinessCoordinator();
    const entry = makeEntry('dev-1');

    const ready = coordinator.waitForReady('dev-1', 500);
    coordinator.resolveReady('dev-1', entry);

    const result = await ready;
    expect(result.udid).to.equal('dev-1');
  });

  it('rejects waiters after markPending', async function () {
    const coordinator = new TunnelReadinessCoordinator();

    const ready = coordinator.waitForReady('dev-2', 500);
    coordinator.markPending('dev-2');

    let caught: Error | undefined;
    try {
      await ready;
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).to.include('not ready');
  });

  it('times out when resolveReady is never called', async function () {
    const coordinator = new TunnelReadinessCoordinator();

    let caught: Error | undefined;
    try {
      await coordinator.waitForReady('dev-3', 50);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).to.equal('NOT_READY');
  });
});
