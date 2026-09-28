import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PassThrough, type Readable} from 'node:stream';
import {describe, it} from 'node:test';

import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import {PlistService} from '../../../src/lib/plist/plist-service.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {readExact} from '../../../src/services/ios/afc/codec.js';

function framePlist(data: PlistDictionary): Buffer {
  const xml = createPlist(data);
  const buf = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

describe('PlistService event-driven receive', function () {
  it('should resolve immediately when message is already queued', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);

    socket.write(framePlist({key: 'value1'}));
    await new Promise((r) => setImmediate(r));

    const msg = await service.receivePlist(1000);
    assert.deepStrictEqual(msg, {key: 'value1'});
    service.close();
  });

  it('should resolve waiting receiver immediately upon data arrival without polling delay', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);

    const start = Date.now();
    const receivePromise = service.receivePlist(1000);

    // Send payload after short tick
    setImmediate(() => {
      socket.write(framePlist({response: 'ok'}));
    });

    const msg = await receivePromise;
    const elapsed = Date.now() - start;

    assert.deepStrictEqual(msg, {response: 'ok'});
    // Should resolve substantially faster than the previous 50ms polling tick
    assert.ok(elapsed < 40, `Expected elapsed < 40ms, got ${elapsed}ms`);
    service.close();
  });

  it('should resolve multiple receivers in FIFO order', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);

    const p1 = service.receivePlist(1000);
    const p2 = service.receivePlist(1000);

    socket.write(framePlist({order: 1}));
    socket.write(framePlist({order: 2}));

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, {order: 1});
    assert.deepStrictEqual(r2, {order: 2});
    service.close();
  });

  it('should timeout with expected message and clean up waiter', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);

    await assert.rejects(service.receivePlist(50), /Timed out waiting for plist response after 50ms/);

    // After timeout, arriving message should go to message queue or subsequent waiter
    socket.write(framePlist({afterTimeout: true}));
    await new Promise((r) => setImmediate(r));

    const subsequent = await service.receivePlist(1000);
    assert.deepStrictEqual(subsequent, {afterTimeout: true});
    service.close();
  });

  it('should reject pending waiters immediately on close()', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);

    const p1 = service.receivePlist(5000);
    const p2 = service.receivePlist(5000);

    service.close();

    await assert.rejects(p1, /Connection closed while waiting for plist response/);
    await assert.rejects(p2, /Connection closed while waiting for plist response/);
  });
});

function afcLikePacket(payloadLength: number): Buffer {
  const header = Buffer.alloc(40);
  header.write('CFA6LPAA', 0, 'ascii');
  header.writeBigUInt64LE(BigInt(header.length + payloadLength), 8);
  header.writeBigUInt64LE(BigInt(header.length + payloadLength), 16);
  return Buffer.concat([header, Buffer.alloc(payloadLength, 7)]);
}

describe('PlistService.detachSocket', function () {
  function collect(socket: Readable): Buffer[] {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.resume();
    return chunks;
  }

  it('hands all later data to the new owner instead of the plist layer', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);
    socket.write(framePlist({Status: 'Complete'}));
    assert.deepStrictEqual(await service.receivePlist(1000), {Status: 'Complete'});

    const detached = service.detachSocket();
    // Nothing of the plist pipeline may keep reading the socket
    assert.strictEqual(detached.listenerCount('data'), 0);
    // Attach the new reader on a later tick, as a protocol client would
    await new Promise((r) => setImmediate(r));
    const chunks = collect(detached);
    // AFC-shaped packets: a still attached plist splitter stops draining them,
    // which pauses the socket after a few megabytes
    const packets = Array.from({length: 6}, () => afcLikePacket(4 * 1024 * 1024));
    for (const packet of packets) {
      if (!socket.write(packet)) {
        await Promise.race([once(socket, 'drain'), new Promise((r) => setTimeout(r, 500))]);
      }
    }
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(Buffer.concat(chunks).length, Buffer.concat(packets).length);
  });

  it('returns bytes the plist layer had buffered but not parsed', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);
    // A frame header announcing more bytes than have arrived stays buffered
    const partial = Buffer.from([0, 0, 0, 100, 1, 2, 3]);
    socket.write(partial);
    await new Promise((r) => setImmediate(r));

    const detached = service.detachSocket();
    await new Promise((r) => setImmediate(r));
    const chunks = collect(detached);
    socket.write(Buffer.from([4, 5]));
    await new Promise((r) => setImmediate(r));

    assert.deepStrictEqual(Buffer.concat(chunks), Buffer.concat([partial, Buffer.from([4, 5])]));
  });

  it('keeps the data for an AFC reader attached on a later tick', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);
    const partial = Buffer.from([0, 0, 0, 100, 1, 2, 3]);
    socket.write(partial);
    await new Promise((r) => setImmediate(r));

    const detached = service.detachSocket();
    await new Promise((r) => setImmediate(r));
    socket.write(Buffer.from([4, 5]));
    await new Promise((r) => setImmediate(r));

    const data = await readExact(detached as any, partial.length + 2, 1000);
    assert.deepStrictEqual(data, Buffer.concat([partial, Buffer.from([4, 5])]));
  });

  it('rejects receives that are still waiting', async function () {
    const socket = new PassThrough();
    const service = new PlistService(socket as any);
    const pending = service.receivePlist(5000);

    service.detachSocket();

    await assert.rejects(pending, /detached while waiting for a plist response/);
  });
});
