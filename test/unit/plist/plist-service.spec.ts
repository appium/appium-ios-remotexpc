import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import {PlistService} from '../../../src/lib/plist/plist-service.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

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
