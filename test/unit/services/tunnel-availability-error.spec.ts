import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {TestContext} from 'node:test';

import {mockImport} from '../../helpers/mock-module.js';

class MockTunnelAvailabilityError extends Error {
  readonly code = 'ERR_TUNNEL_AVAILABILITY';

  constructor(message: string) {
    super(message);
    this.name = 'TunnelAvailabilityError';
  }
}

async function loadServices(t: TestContext, tunnelAvailabilityOverrides: Record<string, unknown> = {}) {
  return await mockImport(t, '../../../src/services.js', import.meta.url, {
    '../../../src/lib/tunnel/tunnel-availability.js': {
      TunnelAvailabilityError: MockTunnelAvailabilityError,
      getAvailableDevices: async () => {
        throw new MockTunnelAvailabilityError(
          'Tunnel registry port not found. Please run the tunnel creation script first',
        );
      },
      getTunnelForDevice: async () => ({
        host: '127.0.0.1',
        port: 1234,
        udid: 'test-udid',
      }),
      ...tunnelAvailabilityOverrides,
    },
  });
}

async function expectTunnelAvailabilityError(action: () => Promise<unknown>, expectedMessage: string) {
  try {
    await action();
    assert.fail('Expected action to throw');
  } catch (err) {
    assert.ok(err instanceof MockTunnelAvailabilityError);
    assert.strictEqual((err as Error).message, expectedMessage);
    assert.strictEqual((err as {code?: string}).code, 'ERR_TUNNEL_AVAILABILITY');
  }
}

describe('TunnelAvailabilityError', function () {
  it('throws a dedicated error when tunnel registry port is missing', async function (t) {
    const services = await loadServices(t);
    await expectTunnelAvailabilityError(
      async () => await services.getAvailableDevices(),
      'Tunnel registry port not found. Please run the tunnel creation script first',
    );
  });

  it('throws a dedicated error when no tunnel exists for a device', async function (t) {
    const services = await loadServices(t, {
      getTunnelForDevice: async () => {
        throw new MockTunnelAvailabilityError(
          'No tunnel found for device test-udid. Please run the tunnel creation script first',
        );
      },
    });
    await expectTunnelAvailabilityError(
      async () => await services.getTunnelForDevice('test-udid'),
      'No tunnel found for device test-udid. Please run the tunnel creation script first',
    );
  });
});
