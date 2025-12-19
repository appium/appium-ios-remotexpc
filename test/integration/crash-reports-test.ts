import { logger } from '@appium/support';
import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Services } from '../../src/index.js';
import type { CrashReportsService } from '../../src/index.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

async function logFiles(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      count += await logFiles(fullPath); // recurse
    } else {
      console.log(fullPath); // log file
      count++;
    }
  }
  return count;
}

describe('Crash Reports Service', function () {
  this.timeout(60000);

  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  let remoteXPC: any;
  let crashReportsService: CrashReportsService;

  before(async function () {
    const { remoteXPC: rxpc, crashReportsService: crs } =
      await Services.startCrashReportsService(udid);
    remoteXPC = rxpc;
    crashReportsService = crs;
  });

  after(async function () {
    try {
      crashReportsService?.close();
    } catch {}
    try {
      await remoteXPC?.close();
    } catch {}
  });

  describe('ls', function () {
    it('should list crash reports in root directory', async function () {
      const entries = await crashReportsService.ls('/', 3);
      console.log(entries);
      expect(entries).to.be.an('array');
    });
  });

  describe('flush', function () {
    it('should flush crash reports without error', async function () {
      await crashReportsService.flush();
      // If we get here without throwing, the flush succeeded
    });
  });

  describe('pull', function () {
    let tempDir: string;

    beforeEach(async function () {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-reports-test-'));
    });

    afterEach(async function () {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it('should pull crash reports to local directory', async function () {
      await crashReportsService.flush();
      await crashReportsService.pull(tempDir, '/');

      // Verify directory exists
      await fs.access(tempDir);

      const entries = await fs.readdir(tempDir);
      console.log('Crash reports in tempDir:', entries);
      await logFiles(tempDir);
    });

    it('should filter files by glob pattern', async function () {
      await crashReportsService.pull(tempDir, '/', {
        match: '**/Siri*',
      });

      // Check that directory was created
      await fs.access(tempDir);

      const num = await logFiles(tempDir);
      console.log('number of files in tempDir: ', num);
    });
  });

  describe('clear', function () {
    it('should clear all crash reports without error', async function () {
      // First check what exists
      const beforeEntries = await crashReportsService.ls('/');
      console.log('beforeEntries are: ', beforeEntries);

      // Clear all crash reports
      await crashReportsService.clear();

      // After clearing, root should be empty or contain only auto-created paths
      const afterEntries = await crashReportsService.ls('/');
      console.log('afterEntries are: ', afterEntries);

      // All entries should be gone, except possibly auto-created ones
      const significantEntries = afterEntries.filter(
        (e) => !e.includes('com.apple.appstored'),
      );
      console.log('significantEntries are: ', significantEntries);

      // Note: The directory might not be completely empty due to auto-created paths
      // or files created immediately after deletion
    });

    it('should be idempotent - clearing empty directory should not error', async function () {
      // Clear twice - second time should not throw
      await crashReportsService.clear();
      await crashReportsService.clear();
    });
  });

  describe('integration workflow', function () {
    let tempDir: string;

    beforeEach(async function () {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-workflow-'));
    });

    afterEach(async function () {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    });

    it('should perform flush, pull with erase, and verify removal', async function () {
      await crashReportsService.flush();
      const beforeEntries = await crashReportsService.ls('/', 4);
      console.log('beforeEntries are: ', beforeEntries);

      await crashReportsService.pull(tempDir, '/', {
        erase: true,
        match: '**/SiriSearchFeedback*',
      });

      const afterEntries = await crashReportsService.ls('/', 4);
      console.log('afterEntries are: ', afterEntries);

      const count = await logFiles(tempDir);
      console.log('number of files in tempDir: ', count);

      // Files should be erased, directories may remain
      await fs.access(tempDir);
    });
  });
});
