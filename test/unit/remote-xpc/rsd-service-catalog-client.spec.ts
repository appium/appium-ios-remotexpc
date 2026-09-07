import assert from 'node:assert/strict';
import * as net from 'node:net';
import {describe, it} from 'node:test';

import {RsdServiceCatalogClient} from '../../../src/lib/remote-xpc/rsd-service-catalog-client.js';
import {
  buildCatalogMessage,
  buildUndecodableMessage,
  toDataFrame,
  toGoAwayFrame,
  toRstStreamFrame,
} from './xpc-fixtures.js';

/** Exceeds the client's internal handshake delay so teardown cannot race it. */
const HANDSHAKE_DRAIN_MS = 200;

/**
 * Serves `writes` to the first client that connects, one socket write each, and
 * hands a client pointed at it to `run`. Drains before teardown because connect()
 * settles on the catalog while the handshake writes are still in flight.
 */
async function withScriptedRsd(
  writes: Buffer[],
  run: (client: RsdServiceCatalogClient) => Promise<void>,
): Promise<void> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    for (const write of writes) {
      socket.write(write);
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', () => resolve((server.address() as net.AddressInfo).port));
  });

  const client = new RsdServiceCatalogClient(['::1', port]);
  try {
    await run(client);
  } finally {
    await new Promise<void>((resolve) => setTimeout(resolve, HANDSHAKE_DRAIN_MS));
    await client.close().catch((): void => undefined);
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('RsdServiceCatalogClient', function () {
  it('returns the catalog that follows an undecodable message in the same frame', async function () {
    const frame = toDataFrame(Buffer.concat([buildUndecodableMessage(1), buildCatalogMessage()]));

    await withScriptedRsd([frame], async (client): Promise<void> => {
      const response = await client.connect({timeoutMs: 5000});

      assert.strictEqual(response.services.length, 1);
      assert.strictEqual(response.services[0].serviceName, 'com.apple.afc.shim.remote');
    });
  });

  it('returns the catalog when it arrives in a later frame than the undecodable message', async function () {
    const writes = [
      toDataFrame(buildUndecodableMessage(1)),
      toDataFrame(buildCatalogMessage('com.apple.mobile.diagnostics_relay.shim.remote', '59999')),
    ];

    await withScriptedRsd(writes, async (client): Promise<void> => {
      const response = await client.connect({timeoutMs: 5000});

      assert.strictEqual(response.services[0].port, '59999');
    });
  });

  it('fails the connect attempt when the stream desyncs', async function () {
    await withScriptedRsd([toDataFrame(Buffer.alloc(64, 0xab))], async (client): Promise<void> => {
      await assert.rejects(client.connect({timeoutMs: 5000}), /Invalid XPC wrapper magic/);
    });
  });

  it('fails the connect attempt as soon as the peer resets the root channel during check-in', async function () {
    await withScriptedRsd([toRstStreamFrame(1, 5)], async (client): Promise<void> => {
      const started = Date.now();

      await assert.rejects(client.connect({timeoutMs: 5000}), /RST_STREAM/);

      assert.ok(Date.now() - started < 2000, 'a reset must not sit out the post-handshake service timeout');
    });
  });

  it('fails the connect attempt as soon as the peer sends GOAWAY during check-in', async function () {
    await withScriptedRsd([toGoAwayFrame(1, 1)], async (client): Promise<void> => {
      const started = Date.now();

      await assert.rejects(client.connect({timeoutMs: 5000}), /GOAWAY/);

      assert.ok(Date.now() - started < 2000, 'GOAWAY must not sit out the post-handshake service timeout');
    });
  });
});
