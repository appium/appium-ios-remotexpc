import { TLV8Error } from '../errors.js';
import type { PairingDataComponentTypeValue, TLV8Item } from '../types.js';

/**
 * Decodes a TLV8-formatted buffer into an array of TLV8 items.
 *
 * @param buffer - A Node.js Buffer containing TLV8 encoded data
 * @returns Array of TLV8Item objects with `type` and `data`
 * @throws TLV8Error if the buffer does not contain valid TLV8 data
 */
export function decodeTLV8(buffer: Buffer): TLV8Item[] {
  const items: TLV8Item[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) {
      throw new TLV8Error(
        `Invalid TLV8: insufficient data for type and length at offset ${offset}`,
      );
    }

    const type = buffer[offset] as PairingDataComponentTypeValue;
    const length = buffer[offset + 1];
    offset += 2;

    if (offset + length > buffer.length) {
      throw new TLV8Error(
        `Invalid TLV8: insufficient data for value at offset ${offset}`,
      );
    }

    const data = buffer.subarray(offset, offset + length);
    offset += length;

    items.push({ type, data });
  }

  return items;
}

/**
 * Decodes a TLV8-formatted buffer into a dictionary mapping
 * each TLV8 type to its corresponding data buffer. If the same
 * type occurs more than once, their values are concatenated.
 *
 * @param buffer - A Node.js Buffer containing TLV8 encoded data
 * @returns A dictionary of type-value mappings
 */
export function decodeTLV8ToDict(
  buffer: Buffer,
): Partial<Record<PairingDataComponentTypeValue, Buffer>> {
  const items = decodeTLV8(buffer);
  const result: Partial<Record<PairingDataComponentTypeValue, Buffer[]>> = {};

  for (const { type, data } of items) {
    if (!result[type]) {
      result[type] = [];
    }
    result[type]!.push(data);
  }

  return Object.fromEntries(
    Object.entries(result).map(([type, buffers]) => [
      type,
      Buffer.concat(buffers as Buffer[]),
    ]),
  ) as Partial<Record<PairingDataComponentTypeValue, Buffer>>;
}
