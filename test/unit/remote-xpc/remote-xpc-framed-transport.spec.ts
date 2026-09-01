import assert from 'node:assert/strict';
import * as net from 'node:net';
import {describe, it} from 'node:test';

import {Http2Constants} from '../../../src/lib/remote-xpc/constants.js';
import {SettingsFrame, WindowUpdateFrame} from '../../../src/lib/remote-xpc/handshake-frames.js';
import {Http2FrameParser, type ParsedDataFrame} from '../../../src/lib/remote-xpc/http2-frame-parser.js';
import {RemoteXpcFramedTransport} from '../../../src/lib/remote-xpc/remote-xpc-framed-transport.js';
import {MAX_XPC_BODY_SIZE, probeXpcFraming} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';
import {buildMessage, buildUndecodableMessage, toDataFrame} from './xpc-fixtures.js';

interface IngestHarness {
  ingest: (chunk: Buffer) => void;
  ingestOn: (streamId: number, chunk: Buffer) => void;
  messages: XPCDictionary[];
  errors: Error[];
  decodeErrors: Error[];
  pendingLength: () => number;
}

function createIngestHarness(): IngestHarness {
  const transport = new RemoteXpcFramedTransport(['::1', 1]);
  const internals = transport as unknown as {
    ingestXpcData: (streamId: number, chunk: Buffer) => void;
    pendingXpcData: Map<number, Buffer>;
  };
  const messages: XPCDictionary[] = [];
  const errors: Error[] = [];
  const decodeErrors: Error[] = [];

  transport.on('message', (body: XPCDictionary) => messages.push(body));
  transport.on('error', (error: Error) => errors.push(error));
  transport.on('decodeError', (error: Error) => decodeErrors.push(error));

  return {
    ingest: (chunk: Buffer) => internals.ingestXpcData(Http2Constants.ROOT_CHANNEL, chunk),
    ingestOn: (streamId: number, chunk: Buffer) => internals.ingestXpcData(streamId, chunk),
    messages,
    errors,
    decodeErrors,
    pendingLength: () => [...internals.pendingXpcData.values()].reduce((total, buf) => total + buf.length, 0),
  };
}

/** A 24-byte wrapper header declaring `bodyLength`, with no body bytes behind it. */
function buildWrapperHeader(bodyLength: bigint): Buffer {
  const header = Buffer.from(buildMessage({n: 1}).subarray(0, 24));
  header.writeBigUInt64LE(bodyLength, 8);
  return header;
}

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

/** Longer than the transport's socket close/end timeouts, so teardown has finished. */
const SOCKET_TEARDOWN_MS = 700;

function settle(ms = 100): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `run` against a transport connected to a bare loopback server, with an
 * 'error' sink attached. Accepted sockets are destroyed on teardown, otherwise
 * server.close() never calls back and the test hangs.
 */
async function withConnectedTransport(
  run: (transport: RemoteXpcFramedTransport, ingest: (chunk: Buffer) => void) => Promise<void>,
): Promise<void> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => accepted.push(socket));
  const port = await listenOnLoopback(server);
  const transport = new RemoteXpcFramedTransport(['::1', port]);
  const ingest = (
    transport as unknown as {ingestXpcData: (streamId: number, chunk: Buffer) => void}
  ).ingestXpcData.bind(transport, Http2Constants.ROOT_CHANNEL);

  try {
    await transport.connect({timeoutMs: 2000});
    transport.on('error', (): void => undefined);
    await run(transport, ingest);
  } finally {
    await transport.close();
    for (const socket of accepted) {
      socket.destroy();
    }
    await closeServer(server);
  }
}

/** RFC 7540 defaults the peer has not overridden: SETTINGS_MAX_FRAME_SIZE and the initial flow-control window. */
const DEFAULT_MAX_FRAME_SIZE = 16384;
const DEFAULT_INITIAL_WINDOW_SIZE = 65535;
const SETTINGS_MAX_FRAME_SIZE = 0x05;
/** First byte of every test payload, so handshake DATA frames (XPC magic) are filtered out on the peer. */
const OUTBOUND_MARKER = 0xaa;

interface PeerHarness {
  transport: RemoteXpcFramedTransport;
  peer: net.Socket;
  sentFrames: () => ParsedDataFrame[];
}

/**
 * Like `withConnectedTransport`, but exposes the accepted peer socket and the
 * marker-prefixed DATA frames it has parsed from the transport so far. The
 * connection preface is not a frame, so it is skipped before parsing.
 */
async function withPeer(run: (harness: PeerHarness) => Promise<void>): Promise<void> {
  const parser = new Http2FrameParser();
  const frames: ParsedDataFrame[] = [];
  let prefaceLeft = Http2Constants.HTTP2_MAGIC.length;
  let onAccepted: (socket: net.Socket) => void = () => undefined;
  const accepted = new Promise<net.Socket>((resolve) => {
    onAccepted = resolve;
  });
  const server = net.createServer((socket): void => {
    socket.on('data', (chunk: Buffer) => {
      const skip = Math.min(prefaceLeft, chunk.length);
      prefaceLeft -= skip;
      for (const frame of parser.append(chunk.subarray(skip))) {
        if (frame.type === 'data' && frame.frame.data[0] === OUTBOUND_MARKER) {
          frames.push(frame.frame);
        }
      }
    });
    onAccepted(socket);
  });
  const port = await listenOnLoopback(server);
  const transport = new RemoteXpcFramedTransport(['::1', port]);
  let peer: net.Socket | undefined;

  try {
    await transport.connect({timeoutMs: 2000});
    transport.on('error', (): void => undefined);
    peer = await accepted;
    await run({transport, peer, sentFrames: () => frames});
  } finally {
    await transport.close();
    peer?.destroy();
    await closeServer(server);
  }
}

function sentBytes(frames: ParsedDataFrame[]): number {
  return frames.reduce((total, frame) => total + frame.bodyLen, 0);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for the peer to receive the payload`);
    }
    await settle(20);
  }
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

  describe('XPC message reassembly', function () {
    it('buffers a message split across chunks and emits it once complete', function () {
      const harness = createIngestHarness();
      const payload = buildMessage({hello: 'world'});
      const splitAt = Math.floor(payload.length / 2);

      harness.ingest(payload.subarray(0, splitAt));
      assert.strictEqual(harness.messages.length, 0);
      assert.strictEqual(harness.pendingLength(), splitAt);

      harness.ingest(payload.subarray(splitAt));
      assert.deepStrictEqual(harness.messages, [{hello: 'world'}]);
      assert.strictEqual(harness.decodeErrors.length, 0);
      assert.strictEqual(harness.errors.length, 0);
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('emits every message when several arrive in one chunk', function () {
      const harness = createIngestHarness();

      harness.ingest(Buffer.concat([buildMessage({n: 1}, 1), buildMessage({n: 2}, 2), buildMessage({n: 3}, 3)]));

      assert.deepStrictEqual(harness.messages, [{n: 1}, {n: 2}, {n: 3}]);
      assert.strictEqual(harness.decodeErrors.length, 0);
      assert.strictEqual(harness.errors.length, 0);
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('reports an undecodable message and still delivers the ones behind it', function () {
      const harness = createIngestHarness();
      const undecodable = buildUndecodableMessage();

      harness.ingest(Buffer.concat([undecodable, buildMessage({n: 1}, 2), buildMessage({n: 2}, 3)]));

      assert.deepStrictEqual(harness.messages, [{n: 1}, {n: 2}]);
      assert.strictEqual(harness.decodeErrors.length, 1);
      assert.match(harness.decodeErrors[0].message, /Unsupported xpc type/);
      assert.strictEqual(harness.errors.length, 0, 'an undecodable message is not a connection failure');
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('does not stall once an undecodable message has been reported', function () {
      const harness = createIngestHarness();

      harness.ingest(buildUndecodableMessage());
      harness.ingest(buildMessage({n: 1}, 2));

      assert.deepStrictEqual(harness.messages, [{n: 1}]);
      assert.strictEqual(harness.decodeErrors.length, 1);
      assert.strictEqual(harness.errors.length, 0);
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('reassembles each stream separately when frames interleave', function () {
      const harness = createIngestHarness();
      const reply = buildMessage({from: 'reply-channel'}, 2);
      const splitAt = Math.floor(reply.length / 2);

      harness.ingestOn(Http2Constants.REPLY_CHANNEL, reply.subarray(0, splitAt));
      harness.ingestOn(Http2Constants.ROOT_CHANNEL, buildMessage({from: 'root-channel'}, 1));
      harness.ingestOn(Http2Constants.REPLY_CHANNEL, reply.subarray(splitAt));

      assert.deepStrictEqual(harness.messages, [{from: 'root-channel'}, {from: 'reply-channel'}]);
      assert.strictEqual(harness.errors.length, 0, 'interleaved streams must not read as a desync');
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('survives an undecodable message when nothing is listening', function () {
      const bare = new RemoteXpcFramedTransport(['::1', 1]);
      const ingest = (bare as unknown as {ingestXpcData: (streamId: number, chunk: Buffer) => void}).ingestXpcData.bind(
        bare,
        Http2Constants.ROOT_CHANNEL,
      );

      assert.strictEqual(bare.listenerCount('decodeError'), 0);
      assert.doesNotThrow(() => ingest(buildUndecodableMessage()));
    });

    it('emits an error and stops buffering when the stream is desynced', function () {
      const harness = createIngestHarness();
      const garbage = Buffer.alloc(32, 0xab);

      harness.ingest(Buffer.concat([garbage, buildMessage({n: 1})]));

      assert.strictEqual(harness.messages.length, 0);
      assert.strictEqual(harness.errors.length, 1);
      assert.match(harness.errors[0].message, /Invalid XPC wrapper magic/);
      assert.strictEqual(harness.pendingLength(), 0);
    });

    it('reports a desync once, not on every later chunk', function () {
      const harness = createIngestHarness();

      harness.ingest(Buffer.alloc(32, 0xab));
      harness.ingest(buildMessage({n: 1}));

      assert.strictEqual(harness.errors.length, 1);
      assert.strictEqual(harness.messages.length, 0);
    });

    it('marks itself disconnected and emits close after a desync', async function () {
      await withConnectedTransport(async (transport, ingest) => {
        assert.strictEqual(transport.isConnected, true);

        const closed = new Promise<void>((resolve) => transport.once('close', () => resolve()));
        ingest(Buffer.alloc(32, 0xab));

        await closed;
        assert.strictEqual(transport.isConnected, false);
      });
    });

    it('does not leave an unhandled rejection behind when a desync closes the socket', async function () {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on('unhandledRejection', onRejection);

      try {
        await withConnectedTransport(async (_transport, ingest) => {
          ingest(Buffer.alloc(32, 0xab));
          await settle();

          assert.deepStrictEqual(rejections, []);
        });
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('accepts messages again after reconnecting past a desync', async function () {
      await withConnectedTransport(async (transport, ingest) => {
        ingest(Buffer.alloc(32, 0xab));
        await settle();

        await transport.connect({timeoutMs: 2000});
        const messages: XPCDictionary[] = [];
        transport.on('message', (body: XPCDictionary) => messages.push(body));
        ingest(buildMessage({n: 1}));

        assert.deepStrictEqual(messages, [{n: 1}], 'the desync latch must not survive a reconnect');
      });
    });

    it('tolerates an explicit close after a desync already closed the socket', async function () {
      await withConnectedTransport(async (transport, ingest) => {
        ingest(Buffer.alloc(32, 0xab));
        await settle();

        await transport.close();
        await transport.close();
      });
    });

    it('does not dereference a socket the desync already closed', async function () {
      await withConnectedTransport(async (transport) => {
        const handleData = (transport as unknown as {handleData: (chunk: Buffer) => void}).handleData.bind(transport);
        const chunk = Buffer.concat([toDataFrame(Buffer.alloc(32, 0xab), 2), toDataFrame(buildMessage({n: 1}), 2)]);

        assert.doesNotThrow(() => handleData(chunk), 'a desync mid-loop must not crash the data handler');
      });
    });

    it('ignores a superseded socket closing after a reconnect', async function () {
      await withConnectedTransport(async (transport, ingest) => {
        ingest(Buffer.alloc(32, 0xab));

        await transport.connect({timeoutMs: 2000});
        let closes = 0;
        transport.on('close', () => {
          closes += 1;
        });
        await settle(SOCKET_TEARDOWN_MS);

        assert.strictEqual(closes, 0, 'the old socket must not emit close on the live connection');
        assert.strictEqual(transport.isConnected, true);
      });
    });

    it('waits for a body declared exactly at the size cap', function () {
      assert.deepStrictEqual(probeXpcFraming(buildWrapperHeader(MAX_XPC_BODY_SIZE)), {status: 'incomplete'});
    });

    it('rejects a body declared one byte past the size cap', function () {
      const probe = probeXpcFraming(buildWrapperHeader(MAX_XPC_BODY_SIZE + BigInt(1)));

      assert.strictEqual(probe.status, 'desynced');
    });

    it('treats an oversized declared body length as a desync instead of buffering it', function () {
      const harness = createIngestHarness();
      const bogus = Buffer.from(buildMessage({n: 1}));
      bogus.writeBigUInt64LE(BigInt('0xffffffffffff0000'), 8);

      harness.ingest(bogus);

      assert.strictEqual(harness.errors.length, 1);
      assert.match(harness.errors[0].message, /exceeds/);
      assert.strictEqual(harness.pendingLength(), 0, 'a corrupt length must not be buffered forever');
    });
  });

  describe('outbound flow control', function () {
    it('splits a payload larger than the default max frame size across DATA frames', async function () {
      await withPeer(async ({transport, sentFrames}) => {
        const payload = Buffer.alloc(40000, OUTBOUND_MARKER);

        transport.sendDataFrame(payload);
        await waitFor(() => sentBytes(sentFrames()) >= payload.length);

        assert.deepStrictEqual(
          sentFrames().map((frame) => frame.bodyLen),
          [DEFAULT_MAX_FRAME_SIZE, DEFAULT_MAX_FRAME_SIZE, 40000 - 2 * DEFAULT_MAX_FRAME_SIZE],
        );
        assert.deepStrictEqual(Buffer.concat(sentFrames().map((frame) => frame.data)), payload);
      });
    });

    it('honours a larger max frame size advertised in the peer SETTINGS', async function () {
      await withPeer(async ({transport, peer, sentFrames}) => {
        const advertised = 2 * DEFAULT_MAX_FRAME_SIZE;
        peer.write(new SettingsFrame(0, {[SETTINGS_MAX_FRAME_SIZE]: advertised}).serialize());
        await settle();
        const payload = Buffer.alloc(40000, OUTBOUND_MARKER);

        transport.sendDataFrame(payload);
        await waitFor(() => sentBytes(sentFrames()) >= payload.length);

        assert.deepStrictEqual(
          sentFrames().map((frame) => frame.bodyLen),
          [advertised, 40000 - advertised],
        );
      });
    });

    it('withholds bytes past the peer window until a WINDOW_UPDATE arrives', async function () {
      await withPeer(async ({transport, peer, sentFrames}) => {
        const payload = Buffer.alloc(100000, OUTBOUND_MARKER);

        transport.sendDataFrame(payload);
        await settle();

        assert.ok(
          sentBytes(sentFrames()) <= DEFAULT_INITIAL_WINDOW_SIZE,
          `sent ${sentBytes(sentFrames())} bytes into a ${DEFAULT_INITIAL_WINDOW_SIZE}-byte window without a WINDOW_UPDATE`,
        );

        peer.write(
          Buffer.concat([
            new WindowUpdateFrame(0, DEFAULT_INITIAL_WINDOW_SIZE).serialize(),
            new WindowUpdateFrame(Http2Constants.ROOT_CHANNEL, DEFAULT_INITIAL_WINDOW_SIZE).serialize(),
          ]),
        );
        await waitFor(() => sentBytes(sentFrames()) >= payload.length);

        assert.deepStrictEqual(Buffer.concat(sentFrames().map((frame) => frame.data)), payload);
      });
    });
  });
});
