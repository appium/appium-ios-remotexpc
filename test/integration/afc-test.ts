import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { Services } from '../../src/index.js';
import { AfcFileMode } from '../../src/services/ios/afc/enums.js';
import AfcService from '../../src/services/ios/afc/index.js';

describe('AFC Service', function () {
  // Allow extra time for device interaction
  this.timeout(60000);

  const udid = process.env.UDID || '';

  let remoteXPC: any;
  let afc: AfcService;

  before(async function () {
    // Establish RemoteXPC connection and locate AFC shim service/port
    const { remoteXPC: rxpc, tunnelConnection } =
      await Services.createRemoteXPCConnection(udid);
    remoteXPC = rxpc;

    const afcDescriptor = remoteXPC.findService(AfcService.RSD_SERVICE_NAME);
    afc = new AfcService([
      tunnelConnection.host,
      parseInt(afcDescriptor.port, 10),
    ]);
  });

  after(async function () {
    // Cleanup: close AFC socket and RemoteXPC
    try {
      afc?.close();
    } catch {
      // ignore
    }
    try {
      await remoteXPC?.close();
    } catch {
      // ignore
    }
  });

  it('should list root directory and contain standard folders', async function () {
    const entries = await afc.listdir('/');
    expect(entries).to.be.an('array');
    // Common AFC-visible directories
    expect(entries).to.include('DCIM');
    expect(entries).to.include('Downloads');
    expect(entries).to.include('Books');
  });

  it('should write, read, rename and delete a file in Downloads', async function () {
    const name1 = `/Downloads/afc_test_${Date.now()}.txt`;
    const name2 = name1.replace('.txt', '_renamed.txt');
    const data = Buffer.from('hello afc');

    // Write
    await afc.setFileContents(name1, data);

    // Stat
    const stat1 = await afc.stat(name1);
    expect(stat1.st_ifmt).to.equal(AfcFileMode.S_IFREG);
    expect(stat1.st_size).to.equal(BigInt(data.length));

    // Read back
    const read = await afc.getFileContents(name1);
    expect(Buffer.compare(read, data)).to.equal(0);

    // Rename
    await afc.rename(name1, name2);
    const read2 = await afc.getFileContents(name2);
    expect(Buffer.compare(read2, data)).to.equal(0);

    // Remove
    await afc.rm(name2);
    const exists = await afc.exists(name2);
    expect(exists).to.equal(false);
  });

  it('should read and write files using streams', async function () {
    const testFileName = `/Downloads/afc_stream_test_${Date.now()}.txt`;
    const testData = Buffer.from('streaming test data with some content');

    const readableStream = Readable.from([testData]);
    await afc.writeFromStream(testFileName, readableStream);

    const stat = await afc.stat(testFileName);
    expect(stat.st_ifmt).to.equal(AfcFileMode.S_IFREG);
    expect(stat.st_size).to.equal(BigInt(testData.length));

    const fileStream = await afc.readToStream(testFileName);
    const chunks: Buffer[] = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    const readData = Buffer.concat(chunks);
    expect(Buffer.compare(readData, testData)).to.equal(0);

    await afc.rm(testFileName);
  });

  it('should push and pull files between local and device', async function () {
    const localSrcPath = path.join(
      os.tmpdir(),
      `afc_push_test_${Date.now()}.txt`,
    );
    const remotePath = `/Downloads/afc_push_test_${Date.now()}.txt`;
    const localDstPath = path.join(
      os.tmpdir(),
      `afc_pull_test_${Date.now()}.txt`,
    );
    const testContent = 'push and pull test content';

    try {
      await fs.writeFile(localSrcPath, testContent, 'utf8');

      await afc.push(localSrcPath, remotePath);

      const deviceContent = await afc.getFileContents(remotePath);
      expect(deviceContent.toString('utf8')).to.equal(testContent);

      await afc.pull(remotePath, localDstPath);

      const pulledContent = await fs.readFile(localDstPath, 'utf8');
      expect(pulledContent).to.equal(testContent);
    } finally {
      try {
        await fs.unlink(localSrcPath);
      } catch {
        // ignore
      }
      try {
        await fs.unlink(localDstPath);
      } catch {
        // ignore
      }
      try {
        await afc.rm(remotePath);
      } catch {
        // ignore
      }
    }
  });

  it('should walk directories and include expected entries', async function () {
    // Walk the root and verify known top-level dirs
    const rootWalk = await afc.walk('/');
    expect(rootWalk).to.be.an('array').and.not.empty;

    const rootEntry = rootWalk.find((e) => e.dir === '/');
    expect(rootEntry).to.exist;
    expect(rootEntry!.dirs).to.be.an('array');
    expect(rootEntry!.files).to.be.an('array');

    // Reuse the same assumptions as the listdir("/") test
    expect(rootEntry!.dirs).to.include('DCIM');
    expect(rootEntry!.dirs).to.include('Downloads');
    expect(rootEntry!.dirs).to.include('Books');

    // Create deterministic files in Downloads and verify walk("/Downloads")
    const ts = Date.now();
    const fname1 = `afc_walk_test_${ts}_1.txt`;
    const fname2 = `afc_walk_test_${ts}_2.txt`;
    const p1 = `/Downloads/${fname1}`;
    const p2 = `/Downloads/${fname2}`;
    const data = Buffer.from('walk content');

    try {
      await afc.setFileContents(p1, data);
      await afc.setFileContents(p2, data);

      const dlWalk = await afc.walk('/Downloads');
      const downloadsEntry = dlWalk.find((e) => e.dir === '/Downloads');
      expect(downloadsEntry).to.exist;
      expect(downloadsEntry!.files).to.include(fname1);
      expect(downloadsEntry!.files).to.include(fname2);
    } finally {
      try {
        await afc.rm(p1);
      } catch {
        /* ignore */
      }
      try {
        await afc.rm(p2);
      } catch {
        /* ignore */
      }
    }
  });

  it('should recursively pull directory with files', async function () {
    const ts = Date.now();
    const testData = Buffer.from('recursive pull test data');

    await afc.mkdir('/Downloads/parent_dir/child_dir');

    const file1 = `/Downloads/file1_${ts}.txt`;
    const file2 = `/Downloads/parent_dir/child_dir/file2_${ts}.log`;

    try {
      await afc.setFileContents(file1, testData);
      await afc.setFileContents(file2, testData);

      await afc.pull('/Downloads', os.tmpdir(), {
        recursive: true,
        match: `**/*_${ts}.@(txt|log)`,
      });

      const localDownloads = path.join(os.tmpdir(), 'Downloads');
      await fs.access(path.join(localDownloads, `file1_${ts}.txt`));
      await fs.access(
        path.join(localDownloads, `parent_dir/child_dir/file2_${ts}.log`),
      );

      // Verify file contents
      const localData = await fs.readFile(
        path.join(localDownloads, `file1_${ts}.txt`),
      );
      expect(Buffer.compare(localData, testData)).to.equal(0);
    } finally {
      try {
        await afc.rm(file1);
      } catch {}
      try {
        await afc.rm(file2);
      } catch {}
      try {
        await afc.rm('/Downloads/child_dir');
      } catch {}
      try {
        const localDownloads = path.join(os.tmpdir(), 'Downloads');
        await fs.rm(localDownloads, { recursive: true, force: true });
      } catch {}
    }
  });

  it('should respect overwrite option when pulling files', async function () {
    const ts = Date.now();
    const testData = Buffer.from('test data for overwrite');
    const file1 = `/Downloads/overwrite_test_${ts}.txt`;
    const localDownloads = path.join(os.tmpdir(), 'Downloads');
    const localFilePath = path.join(localDownloads, `overwrite_test_${ts}.txt`);

    try {
      await afc.setFileContents(file1, testData);

      await afc.pull('/Downloads', os.tmpdir(), {
        recursive: true,
        match: `overwrite_test_${ts}.txt`,
      });

      await fs.access(localFilePath);

      // Second pull with overwrite=false should throw
      try {
        await afc.pull('/Downloads', os.tmpdir(), {
          recursive: true,
          match: `overwrite_test_${ts}.txt`,
          overwrite: false,
        });
      } catch (error: any) {
        expect(error.message).to.include('Local file already exists');
      }

      // Third pull with overwrite=true (default) should succeed
      await afc.pull('/Downloads', os.tmpdir(), {
        recursive: true,
        match: `overwrite_test_${ts}.txt`,
        overwrite: true,
      });

      await fs.access(localFilePath);
    } finally {
      try {
        await afc.rm(file1);
      } catch {}
      try {
        await fs.rm(localDownloads, { recursive: true, force: true });
      } catch {}
    }
  });

  it('should not create empty directories when pulling with match pattern', async function () {
    const ts = Date.now();
    const testData = Buffer.from('match filter test');
    const testDir = `/Downloads/filter_test_${ts}`;

    // Create directory structure with mixed content
    await afc.mkdir(`${testDir}/has_match`);
    await afc.mkdir(`${testDir}/also_has_match`);
    await afc.mkdir(`${testDir}/no_match`);
    await afc.mkdir(`${testDir}/empty_dir`);

    const matchingFile1 = `${testDir}/has_match/target_data.txt`;
    const matchingFile2 = `${testDir}/also_has_match/target_file.txt`;
    const nonMatchingFile1 = `${testDir}/no_match/other.log`;
    const nonMatchingFile2 = `${testDir}/root_file.log`;

    try {
      await afc.setFileContents(matchingFile1, testData);
      await afc.setFileContents(matchingFile2, testData);
      await afc.setFileContents(nonMatchingFile1, testData);
      await afc.setFileContents(nonMatchingFile2, testData);

      // Pull only files matching 'target*.txt'
      const localTestDir = path.join(os.tmpdir(), `afc_filter_test_${ts}`);

      await afc.pull(testDir, localTestDir, {
        recursive: true,
        match: '**/target*.txt',
      });

      await fs.access(localTestDir);

      // Verify matching files exist
      await fs.access(path.join(localTestDir, 'has_match', 'target_data.txt'));
      await fs.access(
        path.join(localTestDir, 'also_has_match', 'target_file.txt'),
      );

      // Verify directories without matching files were not created
      let noMatchDirExists: boolean;
      try {
        await fs.access(path.join(localTestDir, 'no_match'));
        noMatchDirExists = true;
      } catch {
        noMatchDirExists = false;
      }
      expect(noMatchDirExists).to.be.false;

      let emptyDirExists: boolean;
      try {
        await fs.access(path.join(localTestDir, 'empty_dir'));
        emptyDirExists = true;
      } catch {
        emptyDirExists = false;
      }
      expect(emptyDirExists).to.be.false;

      const entries = await fs.readdir(localTestDir);
      expect(entries).to.have.lengthOf(2);
      expect(entries).to.include('has_match');
      expect(entries).to.include('also_has_match');
    } finally {
      try {
        await afc.rm(testDir, true);
      } catch {}
      try {
        await fs.rm(path.join(os.tmpdir(), `afc_filter_test_${ts}`), {
          recursive: true,
          force: true,
        });
      } catch {}
    }
  });
});
