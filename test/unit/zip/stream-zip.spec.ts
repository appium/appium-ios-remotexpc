import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';

import { ZipArchive } from '../../../src/lib/zip/stream-zip.js';

interface FixtureEntry {
  name: string;
  data?: Buffer;
  /** 0 = stored, 8 = deflate. Defaults to stored. */
  method?: number;
  crc?: number;
  /** Extra bytes injected into the local header only (not the central record). */
  localExtra?: Buffer;
}

/**
 * Build a minimal but valid single-disk ZIP archive from the given entries.
 * Sizes/offsets/CRCs are written explicitly so tests can assert exact values.
 */
function buildZip(files: FixtureEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = file.data ?? Buffer.alloc(0);
    const method = file.method ?? 0;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const crc = (file.crc ?? 0) >>> 0;
    const localExtra = file.localExtra ?? Buffer.alloc(0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localChunks.push(local, nameBuf, localExtra, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // central extra length (intentionally 0)
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + localExtra.length + stored.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('zip/stream-zip', function () {
  let dir: string;

  const storedData = Buffer.from('hello stored entry');
  const deflateData = Buffer.from('deflate me '.repeat(50));

  async function openFixture(
    files: FixtureEntry[],
    name = 'fixture.zip',
  ): Promise<ZipArchive> {
    const zipPath = path.join(dir, name);
    await writeFile(zipPath, buildZip(files));
    return ZipArchive.open(zipPath);
  }

  beforeEach(async function () {
    dir = await mkdtemp(path.join(tmpdir(), 'stream-zip-'));
  });

  afterEach(async function () {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists entries with directory/file classification and fields', async function () {
    const zip = await openFixture([
      { name: 'Payload/' },
      { name: 'Payload/app.txt', data: storedData, crc: 0xdeadbeef },
      { name: 'Payload/data.bin', data: deflateData, method: 8 },
    ]);
    try {
      const entries = zip.entries();
      expect(Object.keys(entries)).to.have.members([
        'Payload/',
        'Payload/app.txt',
        'Payload/data.bin',
      ]);

      expect(entries['Payload/'].isDirectory).to.be.true;
      expect(entries['Payload/'].isFile).to.be.false;

      const app = entries['Payload/app.txt'];
      expect(app.isFile).to.be.true;
      expect(app.isDirectory).to.be.false;
      expect(app.method).to.equal(0);
      expect(app.size).to.equal(storedData.length);
      expect(app.compressedSize).to.equal(storedData.length);
      expect(app.crc).to.equal(0xdeadbeef);

      expect(entries['Payload/data.bin'].method).to.equal(8);
      expect(entries['Payload/data.bin'].size).to.equal(deflateData.length);
    } finally {
      await zip.close();
    }
  });

  it('streams a STORED entry verbatim', async function () {
    const zip = await openFixture([{ name: 'a.txt', data: storedData }]);
    try {
      const out = await streamToBuffer(
        await zip.openReadStream(zip.entries()['a.txt']),
      );
      expect(out.equals(storedData)).to.be.true;
    } finally {
      await zip.close();
    }
  });

  it('inflates a DEFLATE entry back to the original bytes', async function () {
    const zip = await openFixture([
      { name: 'a.bin', data: deflateData, method: 8 },
    ]);
    try {
      const out = await streamToBuffer(
        await zip.openReadStream(zip.entries()['a.bin']),
      );
      expect(out.equals(deflateData)).to.be.true;
    } finally {
      await zip.close();
    }
  });

  it('resolves the data offset from the local header extra field', async function () {
    // Central record has extra length 0, local header has a 9-byte extra field.
    const zip = await openFixture([
      {
        name: 'x.txt',
        data: storedData,
        localExtra: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      },
    ]);
    try {
      const out = await streamToBuffer(
        await zip.openReadStream(zip.entries()['x.txt']),
      );
      expect(out.equals(storedData)).to.be.true;
    } finally {
      await zip.close();
    }
  });

  it('returns an empty stream for a zero-byte entry', async function () {
    const zip = await openFixture([{ name: 'empty.txt' }]);
    try {
      const out = await streamToBuffer(
        await zip.openReadStream(zip.entries()['empty.txt']),
      );
      expect(out.length).to.equal(0);
    } finally {
      await zip.close();
    }
  });

  it('refuses to stream a directory entry', async function () {
    const zip = await openFixture([{ name: 'dir/' }]);
    try {
      await zip.openReadStream(zip.entries()['dir/']);
      expect.fail('expected openReadStream to throw for a directory');
    } catch (err) {
      expect((err as Error).message).to.match(/directory/i);
    } finally {
      await zip.close();
    }
  });

  it('throws a clear error when the file is not a ZIP', async function () {
    const notZip = path.join(dir, 'not.zip');
    await writeFile(notZip, Buffer.from('this is definitely not a zip file'));
    try {
      await ZipArchive.open(notZip);
      expect.fail('expected open to throw');
    } catch (err) {
      expect((err as Error).message).to.match(/central directory/i);
    }
  });
});
