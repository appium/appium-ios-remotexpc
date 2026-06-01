import type { Readable } from 'node:stream';

import { ZipArchive, type ZipEntry } from '../../../lib/zip/stream-zip.js';
import { TRANSFER_CHUNK_SIZE } from './constants.js';

/** One IPA central-directory entry. */
export type IpaZipEntry = ZipEntry;

/**
 * Open an IPA archive, run `fn`, and close the handle when done.
 */
export async function withZipFile<T>(
  ipaPath: string,
  fn: (zip: ZipArchive) => Promise<T>,
): Promise<T> {
  const zip = await ZipArchive.open(ipaPath, {
    highWaterMark: TRANSFER_CHUNK_SIZE,
  });
  try {
    return await fn(zip);
  } finally {
    await zip.close();
  }
}

/** List all entries from an already-open IPA archive without extracting them. */
export async function listZipEntries(zip: ZipArchive): Promise<IpaZipEntry[]> {
  return Object.values(zip.entries());
}

/** Open a decompressed readable stream for one zip entry. */
export async function openZipEntryStream(
  zip: ZipArchive,
  entry: IpaZipEntry,
): Promise<Readable> {
  return await zip.openReadStream(entry);
}
