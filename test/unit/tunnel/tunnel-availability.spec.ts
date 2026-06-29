import { expect } from 'chai';
import esmock from 'esmock';
import { describe, it } from 'node:test';

const TEST_UDID = 'test-udid';
const REGISTRY_PORT = 12_345;

type TunnelApiClientMock = {
  getTunnelByUdid?: (udid: string) => Promise<unknown>;
};

function createNetSocketMock(mode: 'connect' | 'refuse') {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const socket = {
    once(event: string, handler: (arg?: unknown) => void) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    destroy() {},
    removeAllListeners() {},
  };

  process.nextTick(() => {
    if (mode === 'connect') {
      for (const handler of handlers.connect ?? []) {
        handler();
      }
      return;
    }
    const err = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    for (const handler of handlers.error ?? []) {
      handler(err);
    }
  });

  return socket;
}

async function loadTunnelAvailability(
  options: {
    tunnelRegistryPort?: string | undefined;
    netMode?: 'connect' | 'refuse';
    tunnelApiClientMock?: TunnelApiClientMock;
  } = {},
) {
  const dependencyMocks: Record<string, unknown> = {
    '@appium/strongbox': {
      strongbox: () => ({}),
      BaseItem: class {
        async read() {
          return options.tunnelRegistryPort;
        }
      },
    },
    'node:net': {
      connect: () => createNetSocketMock(options.netMode ?? 'connect'),
    },
  };

  if (options.tunnelApiClientMock) {
    dependencyMocks['../../../src/lib/tunnel/tunnel-api-client.js'] = {
      TunnelApiClient: class {
        getTunnelByUdid =
          options.tunnelApiClientMock?.getTunnelByUdid ?? (async () => null);
      },
    };
  }

  return await esmock(
    '../../../src/lib/tunnel/tunnel-availability.js',
    dependencyMocks,
  );
}

async function expectTunnelAvailabilityError(
  action: () => Promise<unknown>,
  expectedMessage: string,
  TunnelAvailabilityError: new (message: string) => Error,
) {
  try {
    await action();
    expect.fail('Expected action to throw');
  } catch (err) {
    expect(err).to.be.instanceOf(TunnelAvailabilityError);
    expect((err as Error).message).to.equal(expectedMessage);
    expect((err as { code?: string }).code).to.equal('ERR_TUNNEL_AVAILABILITY');
  }
}

describe('tunnel-availability', function () {
  it('throws when tunnel registry port is missing in strongbox', async function () {
    const mod = await loadTunnelAvailability({ tunnelRegistryPort: undefined });
    await expectTunnelAvailabilityError(
      async () => await mod.getTunnelForDevice(TEST_UDID),
      'Tunnel registry port not found. Please run the tunnel creation script first',
      mod.TunnelAvailabilityError,
    );
  });

  it('throws when tunnel registry port is not a valid TCP port', async function () {
    const mod = await loadTunnelAvailability({ tunnelRegistryPort: '70000' });
    await expectTunnelAvailabilityError(
      async () => await mod.getTunnelForDevice(TEST_UDID),
      'Tunnel registry port "70000" is invalid; expected an integer between 1 and 65535',
      mod.TunnelAvailabilityError,
    );
  });

  it('throws quickly when registry TCP port refuses connections', async function () {
    const mod = await loadTunnelAvailability({
      tunnelRegistryPort: String(REGISTRY_PORT),
      netMode: 'refuse',
    });
    await expectTunnelAvailabilityError(
      async () => await mod.getTunnelForDevice(TEST_UDID),
      `Tunnel registry at 127.0.0.1:${REGISTRY_PORT} is not reachable. Please run the tunnel creation script first`,
      mod.TunnelAvailabilityError,
    );
  });

  it('throws when GET by UDID returns no entry', async function () {
    const mod = await loadTunnelAvailability({
      tunnelRegistryPort: String(REGISTRY_PORT),
      tunnelApiClientMock: {
        getTunnelByUdid: async () => null,
      },
    });
    await expectTunnelAvailabilityError(
      async () => await mod.getTunnelForDevice(TEST_UDID),
      `No tunnel found for device ${TEST_UDID}. Please run the tunnel creation script first`,
      mod.TunnelAvailabilityError,
    );
  });

  it('returns endpoint when GET by UDID returns an entry', async function () {
    const mod = await loadTunnelAvailability({
      tunnelRegistryPort: String(REGISTRY_PORT),
      tunnelApiClientMock: {
        getTunnelByUdid: async () => ({
          udid: TEST_UDID,
          address: 'fe80::1',
          rsdPort: 62078,
        }),
      },
    });

    const endpoint = await mod.getTunnelForDevice(TEST_UDID);
    expect(endpoint).to.deep.equal({
      host: 'fe80::1',
      port: 62078,
      udid: TEST_UDID,
    });
  });
});
