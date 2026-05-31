import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type yauzl from 'yauzl';
import yauzlImport from 'yauzl';

const openZipFile = promisify(yauzlImport.open) as (
  zipPath: string,
  options?: yauzl.Options,
) => Promise<yauzl.ZipFile>;

/**
 * Open an IPA archive, run `fn`, and close the handle when done.
 */
export async function withZipFile<T>(
  ipaPath: string,
  fn: (zipfile: yauzl.ZipFile) => Promise<T>,
): Promise<T> {
  const zipfile = await openZipFile(ipaPath, { lazyEntries: true });
  try {
    return await fn(zipfile);
  } finally {
    zipfile.close();
  }
}

/** Read all entries from an IPA without extracting them. */
export async function readZipEntries(ipaPath: string): Promise<yauzl.Entry[]> {
  return await withZipFile(ipaPath, async (zipfile) => {
    const entries: yauzl.Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zipfile.on('entry', (entry) => {
        entries.push(entry);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
    return entries;
  });
}

/** Open a readable stream for one zip entry. */
export async function openZipEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  const openReadStream = promisify(zipfile.openReadStream.bind(zipfile)) as (
    zipEntry: yauzl.Entry,
  ) => Promise<Readable>;
  return await openReadStream(entry);
}
