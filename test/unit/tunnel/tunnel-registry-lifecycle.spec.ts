import { expect } from 'chai';
import { once } from 'node:events';
import { type AddressInfo, createConnection, createServer } from 'node:net';

import { watchTunnelRegistrySockets } from '../../../src/lib/tunnel/tunnel-registry-lifecycle.js';
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
        packetStreamPort: 0,
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
      rsdProbeIntervalMs: 0,
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
      rsdProbeIntervalMs: 0,
    });

    stop();

    expect(Object.keys(registry.tunnels)).to.have.lengthOf(1);

    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
