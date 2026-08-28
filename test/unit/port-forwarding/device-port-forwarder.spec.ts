import assert from 'node:assert/strict';
import {once} from 'node:events';
import {type AddressInfo, type Server, type Socket, createConnection, createServer} from 'node:net';
import {after, before, describe, it} from 'node:test';

import {DevicePortForwarder} from '../../../src/lib/port-forwarding/index.js';

/** Binds a throwaway server on port 0 to find a free local port. */
async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('DevicePortForwarder early client disconnect', function () {
  let upstreamServer: Server;
  let upstreamPort: number;

  before(async function () {
    upstreamServer = createServer();
    await new Promise<void>((resolve, reject) => {
      upstreamServer.listen(0, '127.0.0.1', resolve);
      upstreamServer.once('error', reject);
    });
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  after(async function () {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('should destroy the upstream socket when the client disconnects during upstream connect', async function () {
    let releaseConnector!: () => void;
    const connectorGate = new Promise<void>((resolve) => (releaseConnector = resolve));
    let upstreamSocket!: Socket;
    const primaryConnector = async (): Promise<Socket> => {
      upstreamSocket = createConnection({host: '127.0.0.1', port: upstreamPort});
      await once(upstreamSocket, 'connect');
      await connectorGate;
      return upstreamSocket;
    };

    const localPort = await getFreePort();
    const forwarder = new DevicePortForwarder(localPort, upstreamPort, {primaryConnector});
    let upstreamConnectedCount = 0;
    let clientDisconnectedCount = 0;
    forwarder.on('upstreamConnected', () => upstreamConnectedCount++);
    forwarder.on('clientDisconnected', () => clientDisconnectedCount++);
    await forwarder.start();

    try {
      const client = createConnection({host: '127.0.0.1', port: localPort});
      const [localSocket] = (await once(forwarder, 'clientConnected')) as [Socket];
      client.destroy();
      await once(localSocket, 'close');

      const disconnected = once(forwarder, 'clientDisconnected');
      releaseConnector();
      await disconnected;

      await once(upstreamSocket, 'close');
      assert.strictEqual(upstreamSocket.destroyed, true);
      assert.strictEqual(upstreamConnectedCount, 0);
      assert.strictEqual(clientDisconnectedCount, 1);
    } finally {
      await forwarder.stop();
    }
  });
});
