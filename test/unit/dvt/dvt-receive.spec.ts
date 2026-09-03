import assert from 'node:assert/strict';
import {Duplex, PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {ChannelFragmenter, isReplyTo} from '../../../src/services/ios/dvt/channel-fragmenter.js';
import {DTX_CONSTANTS} from '../../../src/services/ios/dvt/dtx-message.js';
import {DVTSecureSocketProxyService} from '../../../src/services/ios/dvt/index.js';

class TestableDVTService extends DVTSecureSocketProxyService {
  public attachSocket(socket: Duplex, channels: number[] = []): void {
    (this as unknown as {socket: unknown}).socket = socket;
    for (const channel of channels) {
      (this as unknown as {channelMessages: Map<number, ChannelFragmenter>}).channelMessages.set(
        channel,
        new ChannelFragmenter(),
      );
    }
  }

  public attachConnection(): void {
    (this as unknown as {connection: unknown}).connection = {close: () => {}};
  }

  public get isPumpActive(): boolean {
    return (this as unknown as {isPumpRunning: boolean}).isPumpRunning;
  }

  public receiveMessage(channel: number, signal?: AbortSignal): Promise<[Buffer | null, unknown[]]> {
    return this.recvMessage(channel, signal);
  }

  public receiveReply(channel: number, identifier: number): Promise<[unknown, unknown[]]> {
    return this.recvReplyPlist(channel, identifier);
  }

  public receiveReplyRaw(channel: number, identifier: number): Promise<[Buffer | null, unknown[]]> {
    return this.recvMessage(channel, undefined, isReplyTo(identifier));
  }
}

/** Tracks whether a promise has settled, without awaiting it. */
function isSettled(promise: Promise<unknown>): () => boolean {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  return () => settled;
}

function buildCorrelatedMessage(
  payloadLength: number,
  channelCode: number,
  identifier: number,
  conversationIndex: number,
): Buffer {
  const message = buildDtxMessage(payloadLength, channelCode);
  message.writeUInt32LE(identifier, 16);
  message.writeUInt32LE(conversationIndex, 20);
  return message;
}

function createSocketStub(): Duplex {
  return new Duplex({
    read: () => {},
    write: (_chunk, _encoding, callback) => callback(),
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildDtxMessage(payloadLength: number, channelCode: number = 1): Buffer {
  const header = Buffer.alloc(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
  header.writeUInt32LE(DTX_CONSTANTS.MESSAGE_HEADER_MAGIC, 0);
  header.writeUInt16LE(0, 8); // fragmentId
  header.writeUInt16LE(1, 10); // fragmentCount
  header.writeUInt32LE(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE + payloadLength, 12); // length
  header.writeInt32LE(channelCode, 24); // channelCode

  const payloadHeader = Buffer.alloc(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE);
  payloadHeader.writeBigUInt64LE(BigInt(payloadLength), 8);

  return Buffer.concat([header, payloadHeader, Buffer.alloc(payloadLength)]);
}

describe('DVTSecureSocketProxyService receive path', function () {
  it('should route a reply to the request that asked for it, not to a pending stream reader', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    // A stream reader (e.g. ProcessControl.outputEvents()) is already waiting...
    const streamPromise = service.receiveMessage(1);
    await tick();
    // ...when a request starts waiting for the reply to identifier 7.
    const replyPromise = service.receiveReply(1, 7);
    const replySettled = isSettled(replyPromise);
    await tick();

    socket.write(buildCorrelatedMessage(99, 1, 7, 1)); // the reply
    socket.write(buildCorrelatedMessage(12, 1, 8, 0)); // an unsolicited callback
    await tick();
    await tick();

    assert.ok(replySettled(), 'reply waiter must not be starved by the stream reader');
    await replyPromise;

    const [streamData] = await streamPromise;
    assert.strictEqual(streamData?.length, 12, 'stream reader should get the callback, not the reply');
  });

  it('should route out-of-order replies to their own callers', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    // Two requests in flight on one channel; the device answers the second first.
    const first = service.receiveReplyRaw(1, 10);
    const second = service.receiveReplyRaw(1, 11);
    await tick();

    socket.write(buildCorrelatedMessage(64, 1, 11, 1));
    socket.write(buildCorrelatedMessage(32, 1, 10, 1));
    await tick();
    await tick();

    // A FIFO queue would hand the id-11 reply to the id-10 caller.
    const [firstData] = await first;
    const [secondData] = await second;
    assert.strictEqual(firstData?.length, 32, 'id 10 must get its own 32-byte reply');
    assert.strictEqual(secondData?.length, 64, 'id 11 must get its own 64-byte reply');
  });

  it('should not hand a reply to a mismatched identifier', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    const replyPromise = service.receiveReply(1, 7);
    const replySettled = isSettled(replyPromise);
    await tick();

    socket.write(buildCorrelatedMessage(31, 1, 99, 1)); // a reply for someone else
    await tick();
    await tick();
    assert.ok(!replySettled(), 'must keep waiting for its own identifier');

    socket.write(buildCorrelatedMessage(42, 1, 7, 1));
    await tick();
    await tick();
    const [data] = await replyPromise;
    assert.ok(replySettled());
    assert.ok(data === null || typeof data === 'object');
  });

  it('should fail fast on invalid message header magic', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    const receivePromise = service.receiveMessage(1);
    socket.write(Buffer.alloc(DTX_CONSTANTS.MESSAGE_HEADER_SIZE, 0xde));

    await assert.rejects(receivePromise, /Invalid DTX message header magic/);
  });

  it('should serialize concurrent receivers over the shared byte stream', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    const payloadLength = 16;
    const message = buildDtxMessage(payloadLength, 1);

    const first = service.receiveMessage(1);
    const second = service.receiveMessage(1);

    socket.write(message.subarray(0, DTX_CONSTANTS.MESSAGE_HEADER_SIZE + 4));
    socket.write(message.subarray(DTX_CONSTANTS.MESSAGE_HEADER_SIZE + 4));
    socket.write(message);

    const results = await Promise.all([first, second]);
    for (const [data] of results) {
      assert.ok(data !== null);
      assert.strictEqual(data.length, payloadLength);
    }
  });

  it('should demux concurrent receivers across different channels without deadlocking', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1, 2]);

    const first = service.receiveMessage(1);
    const second = service.receiveMessage(2);

    const msg2 = buildDtxMessage(8, 2);
    const msg1 = buildDtxMessage(12, 1);

    socket.write(msg2);
    socket.write(msg1);

    const [res1, res2] = await Promise.all([first, second]);
    assert.strictEqual(res1[0]?.length, 12);
    assert.strictEqual(res2[0]?.length, 8);
  });

  it('should reject pending receivers when socket errors or closes', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    const receivePromise = service.receiveMessage(1);
    socket.destroy(new Error('Connection reset by peer'));

    await assert.rejects(receivePromise, /Connection reset by peer/);
  });

  it('should unblock a pending receiver and stop the pump on close', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = createSocketStub();
    service.attachSocket(socket, [1]);
    service.attachConnection();

    const receivePromise = service.receiveMessage(1);
    const rejected = assert.rejects(receivePromise, /Service closed/);
    await tick();
    assert.strictEqual(service.isPumpActive, true);

    await service.close();
    await rejected;
    await tick();

    assert.strictEqual(service.isPumpActive, false);

    const nextSocket = new PassThrough();
    service.attachSocket(nextSocket, [1]);
    const nextPromise = service.receiveMessage(1);
    nextSocket.write(buildDtxMessage(10, 1));
    const [data] = await nextPromise;
    assert.strictEqual(data?.length, 10);
  });

  it('should handle AbortSignal cancellation without corrupting subsequent reads', async function () {
    const service = new TestableDVTService('test-udid');
    const socket = new PassThrough();
    service.attachSocket(socket, [1]);

    const ac = new AbortController();
    const abortedPromise = service.receiveMessage(1, ac.signal);
    ac.abort();

    await assert.rejects(abortedPromise, {name: 'AbortError'});

    const subsequentPromise = service.receiveMessage(1);
    socket.write(buildDtxMessage(10, 1));
    const [data] = await subsequentPromise;
    assert.strictEqual(data?.length, 10);
  });
});
