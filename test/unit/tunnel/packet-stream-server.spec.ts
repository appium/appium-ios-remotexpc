import { expect } from 'chai';
import { type AddressInfo, createConnection, createServer } from 'node:net';

import { PacketStreamServer } from '../../../src/lib/tunnel/packet-stream-server.js';
import type { PacketConsumer } from '../../../src/lib/types.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function createMockTunnel() {
  const added: PacketConsumer[] = [];
  const removed: PacketConsumer[] = [];

  return {
    tunnel: {
      addPacketConsumer(consumer: PacketConsumer): void {
        added.push(consumer);
      },
      removePacketConsumer(consumer: PacketConsumer): void {
        removed.push(consumer);
      },
    },
    added,
    removed,
  };
}

function connectClient(port: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port }, () => {
      resolve(client);
    });
    client.once('error', reject);
  });
}

function closeClient(client: import('node:net').Socket): Promise<void> {
  return new Promise((resolve) => {
    client.once('close', () => resolve());
    client.end();
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('PacketStreamServer', function () {
  let port: number;
  let server: PacketStreamServer;

  beforeEach(async function () {
    port = await getFreePort();
    server = new PacketStreamServer(port);
  });

  afterEach(async function () {
    await server.stop();
  });

  it('does not attach tunnel consumer when started with zero clients', async function () {
    const { tunnel, added } = createMockTunnel();

    server.bindTunnel(tunnel);
    await server.start();

    expect(added).to.have.lengthOf(0);
    expect(server.getPacketConsumer()).to.be.null;
  });

  it('attaches tunnel consumer on first client and detaches on last disconnect', async function () {
    const { tunnel, added, removed } = createMockTunnel();

    server.bindTunnel(tunnel);
    await server.start();

    const client = await connectClient(port);
    await waitFor(() => added.length === 1);

    expect(added).to.have.lengthOf(1);
    expect(server.getPacketConsumer()).to.equal(added[0]);
    expect(removed).to.have.lengthOf(0);

    await closeClient(client);
    await waitFor(() => removed.length === 1);

    expect(removed).to.have.lengthOf(1);
    expect(removed[0]).to.equal(added[0]);
  });

  it('keeps tunnel consumer attached while any client remains connected', async function () {
    const { tunnel, added, removed } = createMockTunnel();

    server.bindTunnel(tunnel);
    await server.start();

    const client1 = await connectClient(port);
    const client2 = await connectClient(port);
    await waitFor(() => added.length === 1);

    expect(added).to.have.lengthOf(1);

    await closeClient(client1);
    expect(removed).to.have.lengthOf(0);

    await closeClient(client2);
    await waitFor(() => removed.length === 1);

    expect(removed).to.have.lengthOf(1);
  });

  it('attaches when bindTunnel is called after clients are already connected', async function () {
    const { tunnel, added } = createMockTunnel();

    await server.start();

    const client = await connectClient(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(added).to.have.lengthOf(0);

    server.bindTunnel(tunnel);
    await waitFor(() => added.length === 1);

    expect(added).to.have.lengthOf(1);

    await closeClient(client);
  });

  it('detaches from tunnel when stopped', async function () {
    const { tunnel, added, removed } = createMockTunnel();

    server.bindTunnel(tunnel);
    await server.start();

    const client = await connectClient(port);
    await waitFor(() => added.length === 1);

    expect(added).to.have.lengthOf(1);

    await server.stop();

    expect(removed).to.have.lengthOf(1);
    expect(removed[0]).to.equal(added[0]);

    client.destroy();
  });
});
