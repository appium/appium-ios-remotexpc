import { Readable, Writable } from 'node:stream';

import { buildReadPayload, nextReadChunkSize } from './codec.js';
import { AFC_WRITE_THIS_LENGTH, MAXIMUM_WRITE_SIZE } from './constants.js';
import { AfcError, AfcOpcode } from './enums.js';

type AfcDispatcher = (op: AfcOpcode, payload: Buffer) => Promise<void>;

type AfcWriteDispatcher = (
  op: AfcOpcode,
  payload: Buffer,
  thisLenOverride?: number,
) => Promise<void>;

/**
 * Create a readable stream that pulls file chunks over AFC READ requests.
 */
export function createAfcReadStream(
  handle: bigint,
  size: bigint,
  dispatch: AfcDispatcher,
  receive: () => Promise<{ status: AfcError; data: Buffer }>,
): Readable {
  let left = size;

  return new Readable({
    async read() {
      try {
        if (left <= 0n) {
          this.push(null);
          return;
        }

        const toRead = nextReadChunkSize(left);
        await dispatch(AfcOpcode.READ, buildReadPayload(handle, toRead));
        const { status, data } = await receive();

        if (status !== AfcError.SUCCESS) {
          const errorName = AfcError[status] || 'UNKNOWN';
          this.destroy(new Error(`fread error: ${errorName} (${status})`));
          return;
        }

        left -= BigInt(data.length);

        this.push(data);

        if (BigInt(data.length) < toRead) {
          this.push(null);
        }
      } catch (error) {
        this.destroy(error as Error);
      }
    },
  });
}

/**
 * Create a writable stream that pushes data over AFC WRITE requests.
 *
 * Incoming data is coalesced into WRITE packets of up to `chunkSize` bytes
 * rather than emitting one WRITE per (typically 64 KiB) source chunk. Each WRITE
 * is a separate device round-trip, and over the RSD tunnel every round-trip can
 * stall ~1s on the peer's delayed ACK; coalescing keeps round-trips at
 * ~fileSize/chunkSize while bounding buffered memory to ~chunkSize (we never
 * hold the whole file in RAM). See MAXIMUM_WRITE_SIZE.
 */
export function createAfcWriteStream(
  handle: bigint,
  dispatch: AfcWriteDispatcher,
  receive: () => Promise<{ status: AfcError; data: Buffer }>,
  chunkSize: number = MAXIMUM_WRITE_SIZE,
  onProgress?: (bytesWritten: number) => void,
): Writable {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError(
      `createAfcWriteStream: chunkSize must be a positive integer (got ${chunkSize})`,
    );
  }

  // Buffered-but-not-yet-written source chunks and their total length.
  const pending: Buffer[] = [];
  let pendingLen = 0;
  // Total bytes acknowledged written by the device so far.
  let written = 0;

  // Peel exactly `n` bytes off the front of `pending`, build a single AFC WRITE
  // payload (8-byte handle + data) so it goes out as one packet, and await the
  // status. `n` is always <= pendingLen.
  const writeNextBlock = async (n: number): Promise<void> => {
    const payload = Buffer.allocUnsafe(8 + n);
    payload.writeBigUInt64LE(handle, 0);

    let copied = 0;
    while (copied < n) {
      const head = pending[0];
      const need = n - copied;
      if (head.length <= need) {
        head.copy(payload, 8 + copied);
        copied += head.length;
        pending.shift();
      } else {
        head.copy(payload, 8 + copied, 0, need);
        pending[0] = head.subarray(need);
        copied += need;
      }
    }
    pendingLen -= n;

    await dispatch(AfcOpcode.WRITE, payload, AFC_WRITE_THIS_LENGTH);
    const { status } = await receive();
    if (status !== AfcError.SUCCESS) {
      const errorName = AfcError[status] || 'UNKNOWN';
      throw new Error(`fwrite chunk failed with ${errorName} (${status})`);
    }
    written += n;
    if (onProgress) {
      // A progress callback is observational; never let it fail the transfer.
      try {
        onProgress(written);
      } catch {
        // ignore progress-callback errors
      }
    }
  };

  return new Writable({
    async write(
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      try {
        pending.push(chunk);
        pendingLen += chunk.length;
        // Flush full chunkSize-sized WRITEs, keeping any remainder buffered.
        while (pendingLen >= chunkSize) {
          await writeNextBlock(chunkSize);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    async final(callback: (error?: Error | null) => void) {
      try {
        if (pendingLen > 0) {
          await writeNextBlock(pendingLen);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
