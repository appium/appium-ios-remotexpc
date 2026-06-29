import { fs, node } from '@appium/support';
import _fs from 'node:fs';
import _fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamZip } from '../../../src/services/ios/zipconduit/stream-zip.js';

const PKG_ROOT = node.getModuleRootSync(
  'appium-ios-remotexpc',
  fileURLToPath(import.meta.url),
);
const FIXTURES = path.join(PKG_ROOT, 'test', 'fixtures', 'stream-zip');
const OK_DIR = path.join(FIXTURES, 'ok');
const ERR_DIR = path.join(FIXTURES, 'err');
const SPECIAL_DIR = path.join(FIXTURES, 'special');
const CONTENT_DIR = path.join(FIXTURES, 'content');

const alphabets = [
  'Latin',
  'Ελληνικά',
  'Русский',
  'עִבְרִית',
  '日本語',
  '汉语',
];

let testPathTmp: string;
let testNum = 0;
const basePathTmp = path.join(FIXTURES, '.tmp');

function fixture(...parts: string[]): string {
  return path.join(...parts);
}

async function streamToBuffer(stm: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stm) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readEntryData(zip: StreamZip, name: string): Promise<Buffer> {
  return await streamToBuffer(await zip.stream(name));
}

function normalizeBufferText(buf: Buffer): string {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function assertBuffersEqual(
  actual: Buffer,
  expected: Buffer,
  label?: string,
): void {
  expect(normalizeBufferText(actual), label).to.equal(
    normalizeBufferText(expected),
  );
}

async function assertFilesEqual(
  actualPath: string,
  expectedPath: string,
): Promise<void> {
  assertBuffersEqual(
    await fs.readFile(actualPath),
    await fs.readFile(expectedPath),
    `${actualPath} <> ${expectedPath}`,
  );
}

async function writeStreamToFile(
  stm: NodeJS.ReadableStream,
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await _fsp.open(targetPath, 'w');
  try {
    for await (const chunk of stm) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
}

async function extractViaStream(
  zip: StreamZip,
  entryName: string,
  targetPath: string,
): Promise<void> {
  await writeStreamToFile(await zip.stream(entryName), targetPath);
}

function openZip(
  file: string | undefined,
  options: Record<string, unknown> = {},
): StreamZip {
  return new StreamZip({ ...(file ? { file } : {}), ...options });
}

describe('zipconduit/stream-zip', function () {
  beforeEach(async function () {
    testPathTmp = path.join(basePathTmp, String(testNum++));
    await fs.mkdir(basePathTmp, { recursive: true });
    if (await fs.exists(testPathTmp)) {
      await fs.rimraf(testPathTmp);
    }
    await fs.mkdir(testPathTmp, { recursive: true });
  });

  after(async function () {
    if (await fs.exists(basePathTmp)) {
      await fs.rimraf(basePathTmp);
    }
  });

  for (const file of _fs
    .readdirSync(OK_DIR)
    .filter((f) => path.extname(f).length === 4)) {
    it(`reads ok/${file}`, async function () {
      let expEntriesCount = 10;
      let expEntriesCountInDocDir = 4;
      if (file === 'osx.zip') {
        expEntriesCount = 25;
        expEntriesCountInDocDir = 5;
      } else if (file === 'windows.zip') {
        expEntriesCount = 8;
      }

      const zip = openZip(fixture(OK_DIR, file));
      const entries = await zip.entries();
      expect(zip.entriesCount).to.equal(expEntriesCount);
      const expectedFiles = [
        'BSDmakefile',
        'README.md',
        'doc/api_assets/logo.svg',
        'doc/api_assets/sh.css',
        'doc/changelog-foot.html',
        'doc/sh_javascript.min.js',
      ];
      expect(expectedFiles.every((expFile) => entries[expFile])).to.be.true;
      expect(entries['not-existing-file']).to.be.undefined;

      const entry = entries.BSDmakefile;
      expect(entry).to.exist;
      expect(entry!.isDirectory).to.be.false;
      expect(entry!.isFile).to.be.true;

      const dirEntry = entries['doc/'];
      const dirShouldExist = file !== 'windows.zip';
      if (dirShouldExist) {
        expect(dirEntry).to.exist;
        expect(dirEntry!.isDirectory).to.be.true;
        expect(dirEntry!.isFile).to.be.false;
      }

      await extractViaStream(
        zip,
        'README.md',
        path.join(testPathTmp, 'README.md'),
      );
      await assertFilesEqual(
        path.join(testPathTmp, 'README.md'),
        fixture(CONTENT_DIR, 'README.md'),
      );

      await extractViaStream(
        zip,
        'README.md',
        path.join(testPathTmp, 'README-flat'),
      );
      await assertFilesEqual(
        path.join(testPathTmp, 'README-flat'),
        fixture(CONTENT_DIR, 'README.md'),
      );

      const docDir = path.join(testPathTmp, 'doc-extract');
      await fs.mkdir(docDir, { recursive: true });
      let docExtracted = 0;
      for (const [name, zipEntry] of Object.entries(entries)) {
        if (!name.startsWith('doc/') || !zipEntry.isFile) {
          continue;
        }
        const relative = name.slice('doc/'.length);
        await extractViaStream(zip, name, path.join(docDir, relative));
        docExtracted++;
      }
      expect(docExtracted).to.equal(expEntriesCountInDocDir);
      await assertFilesEqual(
        path.join(docDir, 'api_assets/sh.css'),
        fixture(CONTENT_DIR, 'doc/api_assets/sh.css'),
      );

      const syncData = await readEntryData(zip, 'README.md');
      const expectedData = await fs.readFile(fixture(CONTENT_DIR, 'README.md'));
      assertBuffersEqual(syncData, expectedData, 'streamed entry');

      await zip.close();
    });
  }

  it('reads special/tiny.zip via stream', async function () {
    const zip = openZip(fixture(SPECIAL_DIR, 'tiny.zip'));
    const data = await readEntryData(zip, 'BSDmakefile');
    expect(data.toString('utf8').slice(0, 4)).to.equal('all:');
    await zip.close();
  });

  it('reads zip64 nested archive', async function () {
    const zip = openZip(fixture(SPECIAL_DIR, 'zip64.zip'));
    const internalZip = await readEntryData(zip, 'files.zip');
    const filesZipTmp = path.join(testPathTmp, 'files.zip');
    await fs.writeFile(filesZipTmp, internalZip);
    await zip.close();

    const filesZip = openZip(filesZipTmp);
    await filesZip.waitUntilReady();
    expect(filesZip.entriesCount).to.equal(66667);
    await filesZip.close();
  });

  it('openEntry updates entry metadata', async function () {
    const zip = openZip(fixture(OK_DIR, 'normal.zip'));
    const entries = await zip.entries();
    const entry = entries['doc/changelog-foot.html'];
    expect(entry).to.exist;
    const entryBeforeOpen = { ...entry! };
    const entryAfterOpen = await zip.openEntry(entry!);
    expect(entryAfterOpen).to.not.deep.equal(entryBeforeOpen);
    await zip.close();
  });

  it('opens archives from an existing fd', async function () {
    const fd = await fs.open(fixture(SPECIAL_DIR, 'tiny.zip'), 'r');
    const zip = openZip(undefined, { fd });
    const data = await readEntryData(zip, 'BSDmakefile');
    expect(data.toString('utf8').slice(0, 4)).to.equal('all:');
    await zip.close();
  });

  it('decodes utf8 entry names', async function () {
    const zip = openZip(fixture(SPECIAL_DIR, 'utf8.zip'));
    const names = Object.values(await zip.entries())
      .filter((e) => e.isFile)
      .map((e) => e.name)
      .sort();
    const expectedNames = alphabets.map((a) => `${a}/${a}.txt`);
    expect(names).to.deep.equal(expectedNames);
    await zip.close();
  });

  it('decodes cp1252 entry names', async function () {
    const zip = openZip(fixture(SPECIAL_DIR, 'utf8.zip'), {
      nameEncoding: 'cp1252',
    });
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder('cp1252');
    const expectedNames = alphabets
      .map((a) => textDecoder.decode(textEncoder.encode(a)))
      .map((a) => `${a}/${a}.txt`)
      .sort();
    const names = Object.values(await zip.entries())
      .filter((e) => e.isFile)
      .map((e) => e.name)
      .sort();
    expect(names).to.deep.equal(expectedNames);
    await zip.close();
  });

  it('rejects AES encrypted entries on stream', async function () {
    const zip = openZip(fixture(ERR_DIR, 'enc_aes.zip'));
    await expect(readEntryData(zip, 'README.md')).to.be.rejectedWith(
      'Entry encrypted',
    );
    await zip.close();
  });

  it('rejects ZipCrypto encrypted entries on stream', async function () {
    const zip = openZip(fixture(ERR_DIR, 'enc_zipcrypto.zip'));
    await expect(readEntryData(zip, 'README.md')).to.be.rejectedWith(
      'Entry encrypted',
    );
    await zip.close();
  });

  it('rejects LZMA compression', async function () {
    const zip = openZip(fixture(ERR_DIR, 'lzma.zip'));
    await expect(readEntryData(zip, 'README.md')).to.be.rejectedWith(
      'Unknown compression method: 14',
    );
    await zip.close();
  });

  it('rejects non-zip archives', async function () {
    const zip = openZip(fixture(ERR_DIR, 'rar.rar'));
    await expect(zip.entries()).to.be.rejectedWith('Bad archive');
    await zip.close();
  });

  it('reports CRC errors while streaming corrupt entries', async function () {
    const zip = openZip(fixture(ERR_DIR, 'corrupt_entry.zip'));
    await expect(readEntryData(zip, 'doc/api_assets/logo.svg')).to.be.rejected;
    await zip.close();
  });

  it('reports invalid CRC on stream', async function () {
    const zip = openZip(fixture(ERR_DIR, 'bad_crc.zip'));
    await expect(
      readEntryData(zip, 'doc/api_assets/logo.svg'),
    ).to.be.rejectedWith('Invalid CRC');
    await zip.close();
  });

  it('rejects malicious entry paths unless validation is skipped', async function () {
    const entryName = '..\\..\\..\\..\\..\\..\\..\\..\\file.txt';
    const zip = openZip(fixture(ERR_DIR, 'evil.zip'));
    await expect(zip.entries()).to.be.rejectedWith(
      `Malicious entry: ${entryName}`,
    );
    await zip.close();

    const zipLenient = openZip(fixture(ERR_DIR, 'evil.zip'), {
      skipEntryNameValidation: true,
    });
    const entries = await zipLenient.entries();
    expect(entries[entryName]).to.exist;
    await zipLenient.close();
  });

  it('errors when the archive file is missing', async function () {
    const missingPath = fixture(ERR_DIR, 'doesnotexist.zip');
    const zip = openZip(missingPath);
    await expect(zip.entries()).to.be.rejectedWith(
      `ENOENT: no such file or directory, open '${missingPath}'`,
    );
    await expect(zip.close()).to.eventually.be.fulfilled;
  });

  it('rejects deflate64 compression', async function () {
    const zip = openZip(fixture(ERR_DIR, 'deflate64.zip'));
    await expect(readEntryData(zip, 'README.md')).to.be.rejectedWith(
      'Unknown compression method: 9',
    );
    await zip.close();
  });

  it('streams many files in parallel', async function () {
    const num = 100;
    const zip = openZip(fixture(OK_DIR, 'normal.zip'));
    await zip.entries();
    const files = [
      'doc/changelog-foot.html',
      'doc/sh_javascript.min.js',
      'BSDmakefile',
      'README.md',
    ];
    await Promise.all(
      Array.from({ length: num }, async (_, i) => {
        const file = files[Math.floor(Math.random() * files.length)]!;
        await writeStreamToFile(
          await zip.stream(file),
          path.join(testPathTmp, String(i)),
        );
      }),
    );
    await zip.close();
  });

  it('emits entry events while loading', async function () {
    const zip = openZip(fixture(OK_DIR, 'normal.zip'));
    let entryEventCount = 0;
    zip.on('entry', () => entryEventCount++);
    const entries = await zip.entries();
    expect(Object.keys(entries)).to.have.length(10);
    expect(entryEventCount).to.equal(10);
    await zip.close();
  });

  it('streams README.md contents', async function () {
    const zip = openZip(fixture(OK_DIR, 'normal.zip'));
    const data = await streamToBuffer(await zip.stream('README.md'));
    expect(data.toString('utf8')).to.include('Evented I/O for V8 javascript');
    await zip.close();
  });
});
