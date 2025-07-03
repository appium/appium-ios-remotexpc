import { TLV8_MAX_FRAGMENT_SIZE } from '../constants.js';
import type { TLV8Item } from '../types.js';

/**
 * Encodes an array of TLV8 items into a single TLV8-compliant buffer.
 * If a data value exceeds TLV8_MAX_FRAGMENT_SIZE, it will be split across multiple entries.
 *
 * @param items - Array of TLV8 items to encode
 * @returns A Buffer containing the encoded TLV8 data
 */
export function encodeTLV8(items: TLV8Item[]): Buffer {
  const chunks: Buffer[] = [];

  for (const { type, data } of items) {
    let offset = 0;

    while (offset < data.length) {
      const fragmentLength = Math.min(
        TLV8_MAX_FRAGMENT_SIZE,
        data.length - offset,
      );

      chunks.push(
        Buffer.from([type, fragmentLength]),
        data.subarray(offset, offset + fragmentLength),
      );

      offset += fragmentLength;
    }
  }

  return Buffer.concat(chunks);
}
