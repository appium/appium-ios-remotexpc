import { expect } from 'chai';
import esmock from 'esmock';
import { describe, it } from 'node:test';

class MockTunnelAvailabilityError extends Error {
  readonly code = 'ERR_TUNNEL_AVAILABILITY';

  constructor(message: string) {
    super(message);
    this.name = 'TunnelAvailabilityError';
  }
}

async function loadServices(
  tunnelAvailabilityOverrides: Record<string, unknown> = {},
) {
  return await esmock('../../../src/services.js', {
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

async function expectTunnelAvailabilityError(
  action: () => Promise<unknown>,
  expectedMessage: string,
) {
  try {
    await action();
    expect.fail('Expected action to throw');
  } catch (err) {
    expect(err).to.be.instanceOf(MockTunnelAvailabilityError);
    expect((err as Error).message).to.equal(expectedMessage);
    expect((err as { code?: string }).code).to.equal('ERR_TUNNEL_AVAILABILITY');
  }
}

describe('TunnelAvailabilityError', function () {
  it('throws a dedicated error when tunnel registry port is missing', async function () {
    const services = await loadServices();
    await expectTunnelAvailabilityError(
      async () => await services.getAvailableDevices(),
      'Tunnel registry port not found. Please run the tunnel creation script first',
    );
  });

  it('throws a dedicated error when no tunnel exists for a device', async function () {
    const services = await loadServices({
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
