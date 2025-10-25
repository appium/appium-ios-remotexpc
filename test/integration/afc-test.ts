import { expect } from 'chai';
import fs from 'node:fs';
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

    const fileStream = await afc.getFileStream(testFileName);
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
      fs.writeFileSync(localSrcPath, testContent, 'utf8');

      await afc.push(localSrcPath, remotePath);

      const deviceContent = await afc.getFileContents(remotePath);
      expect(deviceContent.toString('utf8')).to.equal(testContent);

      await afc.pull(remotePath, localDstPath);

      const pulledContent = fs.readFileSync(localDstPath, 'utf8');
      expect(pulledContent).to.equal(testContent);
    } finally {
      try {
        fs.unlinkSync(localSrcPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(localDstPath);
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
});
