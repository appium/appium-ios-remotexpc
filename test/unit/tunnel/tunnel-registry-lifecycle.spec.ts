import { expect } from 'chai';
import { once } from 'node:events';
import { type AddressInfo, createConnection, createServer } from 'node:net';

import {
  watchTunnelRegistryOnDead,
  watchTunnelRegistrySockets,
} from '../../../src/lib/tunnel/tunnel-registry-lifecycle.js';
import type { TunnelRegistry } from '../../../src/lib/types.js';

function makeRegistry(udid: string): TunnelRegistry {
  const now = Date.now();
  return {
    tunnels: {
      [udid]: {
        udid,
        deviceId: 1,
        address: '10.0.0.1',
        rsdPort: 1,
        services: { 'com.apple.test': { port: '1' } },
        connectionType: 'USB',
        productId: 0,
        createdAt: now,
        lastUpdated: now,
      },
    },
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalTunnels: 1,
      activeTunnels: 1,
    },
  };
}

describe('watchTunnelRegistrySockets', function () {
  it('removes registry entry when the watched socket closes', async function () {
    const registry = makeRegistry('dev-1');

    const server = createServer((sock) => {
      sock.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const port = (server.address() as AddressInfo).port;
    const client = createConnection({ host: '127.0.0.1', port });

    await once(client, 'connect');

    let removedUdid: string | undefined;
    const { stop } = watchTunnelRegistrySockets({
      registry,
      watches: [
        {
          udid: 'dev-1',
          socket: client,
        },
      ],
      onRemove: (udid) => {
        removedUdid = udid;
      },
    });

    await once(client, 'close');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registry.tunnels['dev-1']).to.equal(undefined);
    expect(removedUdid).to.equal('dev-1');

    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stop() clears listeners without mutating registry if socket still open', async function () {
    const registry = makeRegistry('dev-2');

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const port = (server.address() as AddressInfo).port;
    const client = createConnection({ host: '127.0.0.1', port });
    await once(client, 'connect');

    const { stop } = watchTunnelRegistrySockets({
      registry,
      watches: [{ udid: 'dev-2', socket: client }],
    });

    stop();

    expect(Object.keys(registry.tunnels)).to.have.lengthOf(1);

    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('watchTunnelRegistryOnDead', function () {
  it('removes registry entry when registerOnDead handler is invoked', async function () {
    const registry = makeRegistry('dev-3');
    let onDeadHandler = (_reason: string) => {};

    let removedUdid: string | undefined;
    const { stop } = watchTunnelRegistryOnDead({
      registry,
      watches: [
        {
          udid: 'dev-3',
          registerOnDead: (handler) => {
            onDeadHandler = handler;
          },
        },
      ],
      onRemove: (udid) => {
        removedUdid = udid;
      },
    });

    onDeadHandler('SSL read failed');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registry.tunnels['dev-3']).to.equal(undefined);
    expect(removedUdid).to.equal('dev-3');

    stop();
  });

  it('stop() ignores subsequent onDead notifications', async function () {
    const registry = makeRegistry('dev-4');
    let onDeadHandler = (_reason: string) => {};

    const { stop } = watchTunnelRegistryOnDead({
      registry,
      watches: [
        {
          udid: 'dev-4',
          registerOnDead: (handler) => {
            onDeadHandler = handler;
          },
        },
      ],
    });

    stop();
    onDeadHandler('should be ignored');

    expect(Object.keys(registry.tunnels)).to.have.lengthOf(1);
  });
});
