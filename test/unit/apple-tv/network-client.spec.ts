import assert from 'node:assert/strict';
import {type AddressInfo, type Socket, createServer} from 'node:net';
import {afterEach, describe, it} from 'node:test';

import {NetworkError} from '../../../src/lib/apple-tv/errors.js';
import {NETWORK_CONSTANTS} from '../../../src/lib/apple-tv/network/constants.js';
import {NetworkClient} from '../../../src/lib/apple-tv/network/network-client.js';
import type {PairingConfig} from '../../../src/lib/apple-tv/types.js';

const CONFIG: PairingConfig = {timeout: 2000, discoveryTimeout: 2000, maxRetries: 1};

function buildPacket(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const magic = Buffer.from(NETWORK_CONSTANTS.MAGIC, 'ascii');
  const length = Buffer.alloc(NETWORK_CONSTANTS.LENGTH_FIELD_SIZE);
  length.writeUInt16BE(body.length, 0);
  return Buffer.concat([magic, length, body]);
}

describe('NetworkClient receiveResponse', function () {
  let server: ReturnType<typeof createServer> | null = null;
  let client: NetworkClient | null = null;

  async function startServer(onConnection: (socket: Socket) => void): Promise<number> {
    server = createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, '127.0.0.1', resolve);
      server!.once('error', reject);
    });
    return (server!.address() as AddressInfo).port;
  }

  async function connectClient(port: number): Promise<NetworkClient> {
    client = new NetworkClient(CONFIG);
    await client.connect('127.0.0.1', port);
    return client;
  }

  afterEach(async function () {
    client?.disconnect();
    client = null;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('should parse a response delivered in a single chunk', async function () {
    const port = await startServer((socket) => {
      socket.write(buildPacket({status: 'ok'}));
    });
    const networkClient = await connectClient(port);

    const response = await networkClient.receiveResponse();
    assert.deepEqual(response, {status: 'ok'});
  });

  it('should accumulate a response fragmented across multiple chunks', async function () {
    const packet = buildPacket({status: 'ok', payload: 'fragmented-response'});
    const port = await startServer((socket) => {
      socket.write(packet.subarray(0, 4));
      setTimeout(() => socket.write(packet.subarray(4, NETWORK_CONSTANTS.HEADER_LENGTH + 3)), 20);
      setTimeout(() => socket.write(packet.subarray(NETWORK_CONSTANTS.HEADER_LENGTH + 3)), 40);
    });
    const networkClient = await connectClient(port);

    const response = await networkClient.receiveResponse();
    assert.deepEqual(response, {status: 'ok', payload: 'fragmented-response'});
  });

  it('should reject when the connection closes before a full response arrives', async function () {
    const port = await startServer((socket) => {
      setTimeout(() => socket.end(), 20);
    });
    const networkClient = await connectClient(port);

    const start = Date.now();
    await assert.rejects(networkClient.receiveResponse(), (error: Error) => {
      assert.ok(error instanceof NetworkError);
      assert.match(error.message, /closed before response/);
      return true;
    });
    assert.ok(Date.now() - start < CONFIG.timeout, 'should reject via close, not timeout');
  });

  it('should reject on invalid protocol magic', async function () {
    const port = await startServer((socket) => {
      socket.write(Buffer.concat([Buffer.from('BADMAGIC!'), Buffer.alloc(2)]));
    });
    const networkClient = await connectClient(port);

    await assert.rejects(networkClient.receiveResponse(), /Invalid protocol magic/);
  });

  it('should reject with a timeout when no data arrives', async function () {
    const port = await startServer(() => {});
    client = new NetworkClient({...CONFIG, timeout: 200});
    await client.connect('127.0.0.1', port);

    await assert.rejects(client.receiveResponse(), /Response timeout after 200ms/);
  });
});
