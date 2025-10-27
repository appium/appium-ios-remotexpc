import { Readable, Writable } from 'node:stream';

import { buildReadPayload, nextReadChunkSize, writeUInt64LE } from './codec.js';
import { AFC_WRITE_THIS_LENGTH } from './constants.js';
import { AfcError, AfcOpcode } from './enums.js';

type AfcDispatcher = (op: AfcOpcode, payload: Buffer) => Promise<void>;

type AfcWriteDispatcher = (
  op: AfcOpcode,
  payload: Buffer,
  thisLenOverride?: number,
) => Promise<void>;

export function createAfcReadStream(
  handle: bigint,
  size: bigint,
  dispatch: AfcDispatcher,
  receive: () => Promise<{ status: AfcError; data: Buffer }>,
): Readable {
  let left = size;
  let totalRead = 0n;

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

        totalRead += BigInt(data.length);
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

export function createAfcWriteStream(
  handle: bigint,
  dispatch: AfcWriteDispatcher,
  receive: () => Promise<{ status: AfcError; data: Buffer }>,
  chunkSize?: number,
): Writable {
  return new Writable({
    async write(
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const end = Math.min(
            offset + (chunkSize ?? chunk.length),
            chunk.length,
          );
          const subchunk = chunk.subarray(offset, end);

          await dispatch(
            AfcOpcode.WRITE,
            Buffer.concat([writeUInt64LE(handle), subchunk]),
            AFC_WRITE_THIS_LENGTH,
          );
          const { status } = await receive();

          if (status !== AfcError.SUCCESS) {
            const errorName = AfcError[status] || 'UNKNOWN';
            callback(
              new Error(
                `fwrite chunk failed with ${errorName} (${status}) at offset ${offset}`,
              ),
            );
            return;
          }
          offset = end;
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}
