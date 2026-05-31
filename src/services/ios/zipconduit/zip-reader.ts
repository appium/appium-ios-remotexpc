import StreamZip from 'node-stream-zip';
import type { Readable } from 'node:stream';

import { TRANSFER_CHUNK_SIZE } from './constants.js';

/** Normalized view of one IPA central-directory entry. */
export type IpaZipEntry = StreamZip.ZipEntry;

const ZIP_OPEN_OPTIONS: StreamZip.StreamZipOptions = {
  chunkSize: TRANSFER_CHUNK_SIZE,
};

/**
 * Open an IPA archive, run `fn`, and close the handle when done.
 */
export async function withZipFile<T>(
  ipaPath: string,
  fn: (zip: StreamZip.StreamZipAsync) => Promise<T>,
): Promise<T> {
  const zip = new StreamZip.async({ file: ipaPath, ...ZIP_OPEN_OPTIONS });
  try {
    return await fn(zip);
  } finally {
    await zip.close();
  }
}

/** Read all entries from an IPA without extracting them. */
export async function readZipEntries(ipaPath: string): Promise<IpaZipEntry[]> {
  return await withZipFile(ipaPath, async (zip) => {
    const entries = await zip.entries();
    return Object.values(entries);
  });
}

/** Open a decompressed readable stream for one zip entry. */
export async function openZipEntryStream(
  zip: StreamZip.StreamZipAsync,
  entry: IpaZipEntry,
): Promise<Readable> {
  return (await zip.stream(entry)) as Readable;
}
