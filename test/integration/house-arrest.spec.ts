import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {HouseArrestService} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {AfcService} from '../../src/services/ios/afc/index.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('HouseArrestService.test');
log.level = 'debug';

describe('House Arrest Service', {timeout: 60000}, function () {
  let udid: string;
  // change this to a dev-signed and installed app
  const bundleId = 'com.example.app'; // used by vendContainer tests
  // download Adobe Acrobat from App Store
  const adobeReader = 'com.adobe.Adobe-Reader'; // used by vendDocuments test

  let houseArrestService: HouseArrestService;

  before(async function () {
    udid = requireDeviceUdid();

    houseArrestService = await Services.startHouseArrestService(udid);
  });

  after(async function () {
    // Discovery RSD is closed by startHouseArrestService.
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
      assert.ok(afcService instanceof AfcService);
    });

    it('should list directories in the application container', async function () {
      afcService = await houseArrestService.vendContainer(bundleId);

      const entries = await afcService.listdir('/');
      assert.ok(Array.isArray(entries));
      assert.ok(['Documents', 'Library'].every((__item) => entries.includes(__item)));
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
      assert.strictEqual(Buffer.compare(localData, testData), 0);

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
      assert.strictEqual(Buffer.compare(remoteData, testData), 0);

      await afcService.rm(remotePath);

      // verify file removal from device
      const exists = await afcService.exists(remotePath);
      assert.strictEqual(exists, false);

      await fs.unlink(localPath);
    });

    it('should throw error for non-existent bundle ID', async function () {
      const invalidBundleId = 'com.invalid.nonexistent.app';

      try {
        const invalidAfcService = await houseArrestService.vendContainer(invalidBundleId);
        invalidAfcService.close();
        assert.fail('Should have thrown error for non-existent bundle ID');
      } catch (error) {
        assert.ok((error as Error).message.includes('Application not installed'));
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
      assert.ok(afcService instanceof AfcService);

      // when adobe reader is installed and initial setup is done, there should be a Welcome.pdf file in the Documents directory
      const entries = await afcService.listdir('/Documents');
      assert.ok(Array.isArray(entries));

      await afcService.setFileContents(remotePath, testData);

      await afcService.pull(remotePath, localPath);
      const pulledData = await fs.readFile(localPath);
      assert.strictEqual(Buffer.compare(pulledData, testData), 0);

      await afcService.rm(remotePath);
      const exists = await afcService.exists(remotePath);
      assert.strictEqual(exists, false);

      await fs.unlink(localPath);
    });
  });
});
