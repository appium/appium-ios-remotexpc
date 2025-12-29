import { logger } from '@appium/support';
import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as Services from '../../src/services.js';
import { AfcService } from '../../src/services/ios/afc/index.js';
import { HouseArrestService } from '../../src/services/ios/house-arrest/index.js';

const log = logger.getLogger('HouseArrestService.test');
log.level = 'debug';

describe('House Arrest Service', function () {
  this.timeout(60000);

  const udid = process.env.UDID || '';
  // change this to a dev-signed and installed app
  const bundleId = 'com.example.app'; // used by vendContainer tests
  // download Adobe Acrobat from App Store
  const adobeReader = 'com.adobe.Adobe-Reader'; // used by vendDocuments test

  let remoteXPC: any;
  let houseArrestService: HouseArrestService;

  before(async function () {
    const { remoteXPC: rxpc, tunnelConnection } =
      await Services.createRemoteXPCConnection(udid);
    remoteXPC = rxpc;

    const houseArrestDescriptor = remoteXPC.findService(
      HouseArrestService.RSD_SERVICE_NAME,
    );
    houseArrestService = new HouseArrestService([
      tunnelConnection.host,
      parseInt(houseArrestDescriptor.port, 10),
    ]);
  });

  after(async function () {
    if (remoteXPC) {
      try {
        await remoteXPC.close();
        log.info('House Arrest service connection closed');
      } catch (error) {
        log.warn('Error during cleanup:', error);
      }
    }
  });

  describe('vendContainer', function () {
    let afcService: AfcService;

    afterEach(async function () {
      if (afcService) {
        try {
          afcService.close();
        } catch {}
      }
    });

    it('should successfully vend into application container', async function () {
      afcService = await houseArrestService.vendContainer(bundleId);
      expect(afcService).to.be.instanceOf(AfcService);
    });

    it('should list directories in the application container', async function () {
      afcService = await houseArrestService.vendContainer(bundleId);

      const entries = await afcService.listdir('/');
      expect(entries).to.be.an('array');
      expect(entries).to.include.members(['Documents', 'Library']);
    });

    it('should pull a file from Documents directory', async function () {
      const testFileName = `test_pull_${Date.now()}.txt`;
      const testData = Buffer.from('Data to be pulled from device');
      const remotePath = `/Documents/${testFileName}`;
      const localPath = path.join(os.tmpdir(), testFileName);

      afcService = await houseArrestService.vendContainer(bundleId);

      await afcService.setFileContents(remotePath, testData);

      await afcService.pull(remotePath, localPath);

      const localData = await fs.readFile(localPath);
      expect(Buffer.compare(localData, testData)).to.equal(0);

      await afcService.rm(remotePath);
      await fs.unlink(localPath).catch(() => {});
    });

    it('should push a local file to Documents directory', async function () {
      const testFileName = `test_push_local_${Date.now()}.txt`;
      const testData = Buffer.from('Local file content for testing');
      const localPath = path.join(os.tmpdir(), testFileName);
      const remotePath = `/Documents/${testFileName}`;

      await fs.writeFile(localPath, testData);

      afcService = await houseArrestService.vendContainer(bundleId);

      await afcService.push(localPath, remotePath);

      const remoteData = await afcService.getFileContents(remotePath);
      expect(Buffer.compare(remoteData, testData)).to.equal(0);

      await afcService.rm(remotePath);

      // verify file removal from device
      const exists = await afcService.exists(remotePath);
      expect(exists).to.be.false;

      await fs.unlink(localPath);
    });

    it('should throw error for non-existent bundle ID', async function () {
      const invalidBundleId = 'com.invalid.nonexistent.app';

      try {
        const invalidAfcService =
          await houseArrestService.vendContainer(invalidBundleId);
        invalidAfcService.close();
        expect.fail('Should have thrown error for non-existent bundle ID');
      } catch (error) {
        expect((error as Error).message).to.include(
          'Application not installed',
        );
      }
    });
  });

  // VendDocuments only works for apps with UIFileSharingEnabled set to true
  // for testing you can install Adobe Acrobat from App Store and create a PDF file
  describe('vendDocuments', function () {
    let afcService: AfcService;

    afterEach(async function () {
      if (afcService) {
        try {
          afcService.close();
        } catch {}
      }
    });

    it('should support vendDocuments lifecycle', async function () {
      const testFileName = `test_vend_docs_${Date.now()}.txt`;
      const testData = Buffer.from('Test data for vendDocuments');
      const remotePath = `/Documents/${testFileName}`;
      const localPath = path.join(os.tmpdir(), testFileName);

      afcService = await houseArrestService.vendDocuments(adobeReader);
      expect(afcService).to.be.instanceOf(AfcService);

      // when adobe reader is installed and initial setup is done, there should be a Welcome.pdf file in the Documents directory
      const entries = await afcService.listdir('/Documents');
      expect(entries).to.be.an('array');

      await afcService.setFileContents(remotePath, testData);

      await afcService.pull(remotePath, localPath);
      const pulledData = await fs.readFile(localPath);
      expect(Buffer.compare(pulledData, testData)).to.equal(0);

      await afcService.rm(remotePath);
      const exists = await afcService.exists(remotePath);
      expect(exists).to.be.false;

      await fs.unlink(localPath);
    });
  });
});
