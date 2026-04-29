import { expect } from 'chai';
import esmock from 'esmock';

type TunnelApiClientMock = {
  hasTunnel?: () => Promise<boolean>;
  getTunnelConnection?: () => Promise<unknown>;
};

async function loadServices(
  tunnelRegistryPort: string | undefined,
  tunnelApiClientMock?: TunnelApiClientMock,
) {
  const dependencyMocks: Record<string, unknown> = {
    '@appium/strongbox': {
      strongbox: () => ({}),
      BaseItem: class {
        async read() {
          return tunnelRegistryPort;
        }
      },
    },
  };

  if (tunnelApiClientMock) {
    dependencyMocks['../../../src/lib/tunnel/tunnel-api-client.js'] = {
      TunnelApiClient: class {
        hasTunnel = tunnelApiClientMock.hasTunnel ?? (async () => true);
        getTunnelConnection =
          tunnelApiClientMock.getTunnelConnection ??
          (async () => ({ host: '127.0.0.1', port: 1234 }));
      },
    };
  }

  return await esmock('../../../src/services.js', dependencyMocks);
}

async function expectTunnelAvailabilityError(
  action: () => Promise<unknown>,
  expectedMessage: string,
  services: { TunnelAvailabilityError: new (...args: any[]) => Error },
) {
  try {
    await action();
    expect.fail('Expected action to throw');
  } catch (err) {
    expect(err).to.be.instanceOf(services.TunnelAvailabilityError);
    expect((err as Error).message).to.equal(expectedMessage);
    expect((err as { code?: string }).code).to.equal('ERR_TUNNEL_AVAILABILITY');
  }
}

describe('TunnelAvailabilityError', function () {
  it('throws a dedicated error when tunnel registry port is missing', async function () {
    const services = await loadServices(undefined);
    await expectTunnelAvailabilityError(
      async () => await services.getAvailableDevices(),
      'Tunnel registry port not found. Please run the tunnel creation script first',
      services,
    );
  });

  it('throws a dedicated error when no tunnel exists for a device', async function () {
    const services = await loadServices('12345', {
      hasTunnel: async () => false,
    });
    await expectTunnelAvailabilityError(
      async () => await services.createRemoteXPCConnection('test-udid'),
      'No tunnel found for device test-udid. Please run the tunnel creation script first',
      services,
    );
  });

  it('throws a dedicated error when tunnel details cannot be resolved', async function () {
    const services = await loadServices('12345', {
      hasTunnel: async () => true,
      getTunnelConnection: async () => undefined,
    });
    await expectTunnelAvailabilityError(
      async () => await services.createRemoteXPCConnection('test-udid'),
      'Failed to get tunnel connection details for device test-udid',
      services,
    );
  });
});
