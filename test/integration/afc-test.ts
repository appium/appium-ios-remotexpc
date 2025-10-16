import { expect } from 'chai';

import { Services } from '../../src/index.js';
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
    expect(stat1.st_ifmt).to.equal('S_IFREG');
    expect(stat1.st_size).to.equal(data.length);

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
});
