import assert from 'node:assert/strict';
import {type Server, type Socket, createConnection, createServer} from 'node:net';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {Usbmux} from '../../../src/lib/usbmux/index.js';
import {UsbmuxEncoder} from '../../../src/lib/usbmux/usbmux-encoder.js';

interface MockUsbmuxd {
  server: Server;
  socket: Socket;
  serverSockets: Socket[];
  /** Writes a plist response frame using the tag of the most recently received client request. */
  respond(payload: Record<string, unknown>): void;
  /** Writes an unsolicited notification frame with tag 0, as real usbmuxd does for Attached/Detached. */
  notify(payload: Record<string, unknown>): void;
}

/**
 * Minimal usbmuxd stand-in: `respond()` echoes the tag of whatever the client last sent
 * (request/response), while `notify()` uses tag 0 like usbmuxd's unsolicited Listen
 * notifications - so no fixture bytes need to be pre-recorded.
 */
async function createMockUsbmuxd(): Promise<MockUsbmuxd> {
  const server = createServer();
  server.listen();
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Invalid server address');
  }

  const socket = createConnection(address.port);
  // Teardown (aborting mid-listen, then closing the socket and server) can legitimately
  // race into an ECONNRESET; that's not a defect under test, so don't let it crash the run.
  socket.on('error', () => {});
  let lastTag = 0;
  let serverSideEncoder: UsbmuxEncoder | null = null;
  const serverSockets: Socket[] = [];

  await new Promise<void>((resolve) => {
    server.on('connection', (serverSocket) => {
      serverSocket.on('error', () => {});
      serverSockets.push(serverSocket);
      const encoder = new UsbmuxEncoder();
      encoder.pipe(serverSocket);
      serverSideEncoder = encoder;

      // Every client request is at least 16 bytes (header); tag lives at offset 12.
      serverSocket.on('data', (chunk: Buffer) => {
        if (chunk.length >= 16) {
          lastTag = chunk.readUInt32LE(12);
        }
      });

      resolve();
    });
  });

  return {
    server,
    socket,
    serverSockets,
    respond(payload) {
      if (!serverSideEncoder) {
        throw new Error('Server has not accepted a connection yet');
      }
      serverSideEncoder.write({tag: lastTag, payload});
    },
    notify(payload) {
      if (!serverSideEncoder) {
        throw new Error('Server has not accepted a connection yet');
      }
      serverSideEncoder.write({tag: 0, payload});
    },
  };
}

describe('usbmux listen', function () {
  let usbmux: Usbmux | null;
  let mock: MockUsbmuxd | null;

  beforeEach(function () {
    usbmux = null;
    mock = null;
  });

  afterEach(async function () {
    if (usbmux) {
      usbmux.close();
      usbmux = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (mock) {
      mock.server.close();
      mock = null;
    }
  });

  it('yields an attach event once the Listen request is acknowledged', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();

    // Give the client a tick to send the Listen request before we respond.
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify({
      MessageType: 'Attached',
      DeviceID: 42,
      Properties: {
        ConnectionSpeed: 480000000,
        ConnectionType: 'USB',
        DeviceID: 42,
        LocationID: 0,
        ProductID: 4776,
        SerialNumber: 'new-device-udid',
        USBSerialNumber: 'new-device-udid',
      },
    });

    const result = await iterator.next();
    assert.strictEqual(result.done, false);
    assert.strictEqual(result.value?.type, 'attach');
    if (result.value?.type === 'attach') {
      assert.strictEqual(result.value.device.Properties.SerialNumber, 'new-device-udid');
    }

    await iterator.return?.();
  });

  it('yields a detach event carrying only the DeviceID', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();

    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify({MessageType: 'Detached', DeviceID: 7});

    const result = await iterator.next();
    assert.strictEqual(result.done, false);
    assert.deepStrictEqual(result.value, {type: 'detach', deviceId: 7});

    await iterator.return?.();
  });

  it('delivers multiple events in order across separate next() calls', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();

    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify({
      MessageType: 'Attached',
      DeviceID: 1,
      Properties: {
        ConnectionSpeed: 0,
        ConnectionType: 'USB',
        DeviceID: 1,
        LocationID: 0,
        ProductID: 0,
        SerialNumber: 'device-a',
        USBSerialNumber: 'device-a',
      },
    });
    mock.notify({MessageType: 'Detached', DeviceID: 1});

    const first = await iterator.next();
    const second = await iterator.next();

    assert.strictEqual(first.value?.type, 'attach');
    assert.deepStrictEqual(second.value, {type: 'detach', deviceId: 1});

    await iterator.return?.();
  });

  it('ends iteration when aborted via signal', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const controller = new AbortController();
    const iterator = usbmux.listen({signal: controller.signal})[Symbol.asyncIterator]();

    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    const pendingNext = iterator.next();
    controller.abort();

    const result = await pendingNext;
    assert.strictEqual(result.done, true);
  });

  it('rejects when the Listen request itself fails', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();

    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 1});

    await assert.rejects(iterator.next());
  });

  it('delivers tag-0 notifications even when Listen is not the first request on the connection', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const buidPromise = usbmux.readBUID();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({BUID: 'host-buid'});
    assert.strictEqual(await buidPromise, 'host-buid');

    const iterator = usbmux.listen()[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify({MessageType: 'Detached', DeviceID: 3});

    const result = await iterator.next();
    assert.deepStrictEqual(result.value, {type: 'detach', deviceId: 3});

    await iterator.return?.();
  });

  it('delivers a reply carrying MessageType Attached to its pending request, not to listeners', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    const buidPromise = usbmux.readBUID();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Older plist parsers flatten nested DeviceList entries, so replies can carry this top-level key
    mock.respond({BUID: 'host-buid', MessageType: 'Attached'});
    assert.strictEqual(await buidPromise, 'host-buid');

    mock.notify({MessageType: 'Detached', DeviceID: 5});
    const result = await iterator.next();
    assert.deepStrictEqual(result.value, {type: 'detach', deviceId: 5});

    await iterator.return?.();
  });

  it('ignores unsolicited frames whose plist root is not a dictionary', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify(['not', 'a', 'dictionary'] as unknown as Record<string, unknown>);
    mock.notify({MessageType: 'Detached', DeviceID: 9});

    const result = await iterator.next();
    assert.deepStrictEqual(result.value, {type: 'detach', deviceId: 9});

    await iterator.return?.();
  });

  it('ends iteration when the connection is closed', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    const pendingNext = iterator.next();
    await usbmux.close();
    usbmux = null;

    const result = await pendingNext;
    assert.strictEqual(result.done, true);
  });

  it('rejects when usbmuxd drops the connection', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen()[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    const pendingNext = iterator.next();
    mock.server.close();
    for (const serverSocket of mock.serverSockets) {
      serverSocket.destroy();
    }

    await assert.rejects(pendingNext, /usbmuxd connection closed/);
  });

  it('ends immediately when given an already-aborted signal', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const result = await usbmux.listen({signal: AbortSignal.abort()}).next();
    assert.strictEqual(result.done, true);
  });

  it('throws when listen() is already active on the connection', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen();
    assert.throws(() => usbmux!.listen(), /already active/);

    await iterator.return();
  });

  it('closes the connection once iteration stops', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const serverSideClosed = new Promise<void>((resolve) => mock!.serverSockets[0].once('close', () => resolve()));
    const iterator = usbmux.listen();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    mock.notify({MessageType: 'Detached', DeviceID: 1});
    for await (const event of iterator) {
      assert.strictEqual(event.type, 'detach');
      break;
    }

    await serverSideClosed;
    assert.ok(mock.socket.destroyed);
    assert.throws(() => usbmux!.listen(), /closed usbmuxd connection/);
  });

  it('delivers already-received events before rejecting on a dropped connection', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});
    mock.notify({MessageType: 'Detached', DeviceID: 4});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const clientClosed = new Promise<void>((resolve) => mock!.socket.once('close', () => resolve()));
    for (const serverSocket of mock.serverSockets) {
      serverSocket.destroy();
    }
    await clientClosed;

    assert.deepStrictEqual((await iterator.next()).value, {type: 'detach', deviceId: 4});
    await assert.rejects(iterator.next(), /usbmuxd connection closed/);
  });

  it('resolves concurrent next() calls in order', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    const iterator = usbmux.listen();
    await new Promise((resolve) => setTimeout(resolve, 50));
    mock.respond({MessageType: 'Result', Number: 0});

    const first = iterator.next();
    const second = iterator.next();
    mock.notify({MessageType: 'Detached', DeviceID: 1});
    mock.notify({MessageType: 'Detached', DeviceID: 2});

    assert.deepStrictEqual((await first).value, {type: 'detach', deviceId: 1});
    assert.deepStrictEqual((await second).value, {type: 'detach', deviceId: 2});

    await iterator.return();
  });

  it('throws when listening on an already-closed connection', async function () {
    mock = await createMockUsbmuxd();
    usbmux = new Usbmux(mock.socket);

    await usbmux.close();
    assert.throws(() => usbmux!.listen(), /closed usbmuxd connection/);
  });
});
