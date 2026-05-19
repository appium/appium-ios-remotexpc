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

  it('requires consecutive RSD probe failures before removing a tunnel', async function () {
    const registry = makeRegistry('dev-3');

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const port = (server.address() as AddressInfo).port;
    const client = createConnection({ host: '127.0.0.1', port });
    await once(client, 'connect');

    let removed = false;
    const { stop } = watchTunnelRegistrySockets({
      registry,
      watches: [
        {
          udid: 'dev-3',
          socket: client,
          rsdProbe: { host: '127.0.0.1', port: 59999 },
        },
      ],
      rsdProbeIntervalMs: 30,
      rsdProbeConnectTimeoutMs: 20,
      rsdProbeFailureThreshold: 3,
      onRemove: () => {
        removed = true;
      },
    });

    // One failed probe should not remove the tunnel yet.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(registry.tunnels['dev-3']).to.not.equal(undefined);
    expect(removed).to.equal(false);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(registry.tunnels['dev-3']).to.equal(undefined);
    expect(removed).to.equal(true);

    stop();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not count probe timeouts as consecutive failures', async function () {
    const registry = makeRegistry('dev-4');

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });

    const client = createConnection({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
    });
    await once(client, 'connect');

    let removed = false;
    const { stop } = watchTunnelRegistrySockets({
      registry,
      watches: [
        {
          udid: 'dev-4',
          socket: client,
          // TEST-NET address with no route — probes should time out (inconclusive).
          rsdProbe: { host: '192.0.2.1', port: 9 },
        },
      ],
      rsdProbeIntervalMs: 30,
      rsdProbeConnectTimeoutMs: 20,
      rsdProbeFailureThreshold: 3,
      onRemove: () => {
        removed = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registry.tunnels['dev-4']).to.not.equal(undefined);
    expect(removed).to.equal(false);

    stop();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('treats ECONNRESET on the probe socket as reachable', async function () {
    const registry = makeRegistry('dev-5');

    const resetServer = createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      resetServer.listen(0, '127.0.0.1', resolve);
      resetServer.once('error', reject);
    });
    const rsdPort = (resetServer.address() as AddressInfo).port;

    const upstream = createServer();
    await new Promise<void>((resolve, reject) => {
      upstream.listen(0, '127.0.0.1', resolve);
      upstream.once('error', reject);
    });
    const client = createConnection({
      host: '127.0.0.1',
      port: (upstream.address() as AddressInfo).port,
    });
    await once(client, 'connect');

    let removed = false;
    const { stop } = watchTunnelRegistrySockets({
      registry,
      watches: [
        {
          udid: 'dev-5',
          socket: client,
          rsdProbe: { host: '127.0.0.1', port: rsdPort },
        },
      ],
      rsdProbeIntervalMs: 30,
      rsdProbeConnectTimeoutMs: 500,
      rsdProbeFailureThreshold: 3,
      onRemove: () => {
        removed = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registry.tunnels['dev-5']).to.not.equal(undefined);
    expect(removed).to.equal(false);

    stop();
    client.destroy();
    await new Promise<void>((resolve) => {
      resetServer.close(() => {
        upstream.close(() => resolve());
      });
    });
  });
});
