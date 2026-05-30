import { expect } from 'chai';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AFC_WRITE_THIS_LENGTH } from '../../../src/services/ios/afc/constants.js';
import { AfcError, AfcOpcode } from '../../../src/services/ios/afc/enums.js';
import { createAfcWriteStream } from '../../../src/services/ios/afc/stream-utils.js';

interface CapturedWrite {
  op: AfcOpcode;
  payload: Buffer;
  thisLen?: number;
}

/**
 * Drive `createAfcWriteStream` with `data` split into `srcChunkSize` source
 * chunks (simulating an fs read stream) and capture every AFC WRITE dispatched.
 */
async function runWrite(
  data: Buffer,
  chunkSize: number,
  {
    handle = 7n,
    srcChunkSize = 64 * 1024,
    status = AfcError.SUCCESS,
  }: { handle?: bigint; srcChunkSize?: number; status?: AfcError } = {},
): Promise<{ writes: CapturedWrite[]; progress: number[] }> {
  const writes: CapturedWrite[] = [];
  const dispatch = async (
    op: AfcOpcode,
    payload: Buffer,
    thisLen?: number,
  ): Promise<void> => {
    // Snapshot the payload — the stream owns/reuses the source buffers.
    writes.push({ op, payload: Buffer.from(payload), thisLen });
  };
  const receive = async (): Promise<{ status: AfcError; data: Buffer }> => ({
    status,
    data: Buffer.alloc(0),
  });

  const progress: number[] = [];
  const ws = createAfcWriteStream(handle, dispatch, receive, chunkSize, (b) =>
    progress.push(b),
  );

  const srcChunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += srcChunkSize) {
    srcChunks.push(data.subarray(i, i + srcChunkSize));
  }

  await pipeline(Readable.from(srcChunks), ws);
  return { writes, progress };
}

/** Build a buffer whose byte i == i % 256, so ordering is verifiable. */
function rampBuffer(len: number): Buffer {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    b[i] = i % 256;
  }
  return b;
}

/** Concatenate the data portion (after the 8-byte handle) of each WRITE. */
function reassemble(writes: CapturedWrite[]): Buffer {
  return Buffer.concat(writes.map((w) => w.payload.subarray(8)));
}

describe('createAfcWriteStream', function () {
  it('coalesces source chunks into chunkSize-sized WRITEs and preserves data', async function () {
    const data = rampBuffer(3500);
    const { writes, progress } = await runWrite(data, 1024);

    // 1024 + 1024 + 1024 + 428
    expect(writes.map((w) => w.payload.length - 8)).to.deep.equal([
      1024, 1024, 1024, 428,
    ]);
    expect(reassemble(writes).equals(data)).to.equal(true);
    expect(progress).to.deep.equal([1024, 2048, 3072, 3500]);
  });

  it('sends each WRITE with the handle prefix, WRITE opcode and thisLength', async function () {
    const { writes } = await runWrite(rampBuffer(2500), 1000, { handle: 42n });
    for (const w of writes) {
      expect(w.op).to.equal(AfcOpcode.WRITE);
      expect(w.thisLen).to.equal(AFC_WRITE_THIS_LENGTH);
      expect(w.payload.readBigUInt64LE(0)).to.equal(42n);
    }
  });

  it('sends a single WRITE when the file is smaller than chunkSize', async function () {
    const data = rampBuffer(1000);
    const { writes } = await runWrite(data, 4096);
    expect(writes).to.have.lengthOf(1);
    expect(writes[0].payload.length - 8).to.equal(1000);
    expect(reassemble(writes).equals(data)).to.equal(true);
  });

  it('handles a size that is an exact multiple of chunkSize without a trailing empty WRITE', async function () {
    const { writes, progress } = await runWrite(rampBuffer(2000), 1000);
    expect(writes.map((w) => w.payload.length - 8)).to.deep.equal([1000, 1000]);
    expect(progress).to.deep.equal([1000, 2000]);
  });

  it('splits a single source chunk larger than chunkSize', async function () {
    // One 5000-byte source chunk, 2000-byte AFC chunks => 2000+2000+1000.
    const data = rampBuffer(5000);
    const { writes } = await runWrite(data, 2000, { srcChunkSize: 1 << 20 });
    expect(writes.map((w) => w.payload.length - 8)).to.deep.equal([
      2000, 2000, 1000,
    ]);
    expect(reassemble(writes).equals(data)).to.equal(true);
  });

  it('writes nothing for an empty stream', async function () {
    const { writes, progress } = await runWrite(Buffer.alloc(0), 1024);
    expect(writes).to.have.lengthOf(0);
    expect(progress).to.have.lengthOf(0);
  });

  it('rejects when the device returns a non-success status', async function () {
    let err: unknown;
    try {
      await runWrite(rampBuffer(2048), 1024, {
        status: AfcError.UNKNOWN_ERROR,
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
  });

  it('throws for an invalid chunkSize', function () {
    const noop = async (): Promise<void> => {};
    const recv = async (): Promise<{ status: AfcError; data: Buffer }> => ({
      status: AfcError.SUCCESS,
      data: Buffer.alloc(0),
    });
    expect(() => createAfcWriteStream(1n, noop, recv, 0)).to.throw(TypeError);
    expect(() => createAfcWriteStream(1n, noop, recv, -5)).to.throw(TypeError);
  });
});
