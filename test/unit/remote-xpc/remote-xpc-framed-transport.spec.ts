import assert from 'node:assert/strict';
import * as net from 'node:net';
import {describe, it} from 'node:test';

import {RemoteXpcFramedTransport} from '../../../src/lib/remote-xpc/remote-xpc-framed-transport.js';

function listenOnLoopback(server: net.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '::1', (): void => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('RemoteXpcFramedTransport', function () {
  it('rejects connect() on socket failure instead of emitting an unlistened error', async function () {
    const probe = net.createServer();
    const port = await listenOnLoopback(probe);
    await closeServer(probe);

    const transport = new RemoteXpcFramedTransport(['::1', port]);
    await assert.rejects(transport.connect({timeoutMs: 2000}), /ECONNREFUSED/);
  });

  it('emits error when the socket fails in the connected phase', async function () {
    let onAccepted: (socket: net.Socket) => void = () => undefined;
    const acceptedPromise = new Promise<net.Socket>((resolve) => {
      onAccepted = resolve;
    });
    const server = net.createServer((socket): void => {
      onAccepted(socket);
    });
    const port = await listenOnLoopback(server);

    let acceptedSocket: net.Socket | undefined;
    const transport = new RemoteXpcFramedTransport(['::1', port]);
    try {
      await transport.connect({timeoutMs: 2000});
      acceptedSocket = await acceptedPromise;

      const errorPromise = new Promise<Error>((resolve) => transport.once('error', resolve));
      acceptedSocket.resetAndDestroy();

      const error = await errorPromise;
      assert.match(error.message, /ECONNRESET/);
    } finally {
      await transport.close();
      acceptedSocket?.destroy();
      await closeServer(server);
    }
  });
});
