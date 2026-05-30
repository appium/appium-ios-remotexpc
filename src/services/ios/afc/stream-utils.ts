import { Readable, Writable } from 'node:stream';

import { buildReadPayload, nextReadChunkSize, writeUInt64LE } from './codec.js';
import { MAXIMUM_WRITE_SIZE } from './constants.js';
import { AfcError, AfcOpcode } from './enums.js';

export type AfcSendAndWait = (
  op: AfcOpcode,
  headerPayload?: Buffer,
  content?: Buffer,
) => Promise<{ status: AfcError; data: Buffer }>;

export type AfcFileWriteAndWait = (
  handlePayload: Buffer,
  content: Buffer,
) => Promise<{ status: AfcError; data: Buffer }>;

/**
 * Create a readable stream that pulls file chunks over AFC READ requests.
 */
export function createAfcReadStream(
  handle: bigint,
  size: bigint,
  sendAndWait: AfcSendAndWait,
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
        const { status, data } = await sendAndWait(
          AfcOpcode.READ,
          buildReadPayload(handle, toRead),
        );

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
 */
export function createAfcWriteStream(
  handle: bigint,
  writeChunk: AfcFileWriteAndWait,
  chunkSize = MAXIMUM_WRITE_SIZE,
): Writable {
  const handlePayload = writeUInt64LE(handle);

  return new Writable({
    async write(
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const end = Math.min(offset + chunkSize, chunk.length);
          const subchunk = chunk.subarray(offset, end);

          const { status } = await writeChunk(handlePayload, subchunk);

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
