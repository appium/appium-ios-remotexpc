import { logger } from '@appium/support';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Services } from '../../src/index.js';
import type { CrashReportsService } from '../../src/index.js';
import { AfcService } from '../../src/services/ios/afc/index.js';
import { CrashReportsService as CrashReportsServiceClass } from '../../src/services/ios/crash-reports/index.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

const TEST_REPORT_STEM = 'remotexpc-integration-test';

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function testReportGlob(): string {
  return `**/${TEST_REPORT_STEM}*.ips`;
}

function testReportRemoteName(tag: string): string {
  return `${TEST_REPORT_STEM}-${tag}-2020-01-01-120000.ips`;
}

async function writeTestCrashReport(
  udid: string,
  remoteFileName: string,
): Promise<void> {
  const afc = new AfcService(
    udid,
    true,
    CrashReportsServiceClass.RSD_COPY_MOBILE_NAME,
  );
  const localPath = path.join(os.tmpdir(), remoteFileName);
  const stem = path.posix.basename(remoteFileName, '.ips');
  const content =
    `{"bug_type":"999","incident_id":"${stem}","timestamp":"2020-01-01 00:00:00.000 +0000","name":"${stem}"}\n` +
    `{"payload":"ok"}\n`;

  try {
    await fs.writeFile(localPath, content);
    await afc.push(localPath, `/${remoteFileName}`);
  } finally {
    await fs.unlink(localPath).catch(() => {});
    afc.close();
  }
}

describe('Crash Reports Service', function () {
  this.timeout(120000); // pulling crash reports can take time

  const udid = process.env.UDID || '';

  let crashReportsService: CrashReportsService;

  before(async function () {
    crashReportsService = await Services.startCrashReportsService(udid);
  });

  after(async function () {
    try {
      crashReportsService?.close();
    } catch {}
  });

  describe('ls', function () {
    it('should list crash reports in root directory', async function () {
      const entries = await crashReportsService.ls('/', 3);
      expect(entries).to.be.an('array');
    });

    it('should list crash reports with infinite depth (-1)', async function () {
      const entries = await crashReportsService.ls('/', -1);
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

    // this will take time if there are many crash reports (this is expected behavior)
    it('should pull crash reports to local directory', async function () {
      await crashReportsService.flush();
      await crashReportsService.pull(tempDir, '/');

      await fs.access(tempDir);
      const entries = await fs.readdir(tempDir);

      expect(entries).to.not.be.empty;
      expect(entries).to.be.an('array');
    });

    it('should filter files by glob pattern and pull', async function () {
      const remoteName = testReportRemoteName('glob');
      await writeTestCrashReport(udid, remoteName);
      const match = testReportGlob();

      await crashReportsService.pull(tempDir, '/', { match });

      const files = await listFilesRecursive(tempDir);
      expect(files.length).to.be.greaterThan(0);
      expect(
        files.every((file) => path.basename(file).includes(TEST_REPORT_STEM)),
      ).to.be.true;
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
      const remoteName = testReportRemoteName('erase');
      const remotePath = `/${remoteName}`;
      await writeTestCrashReport(udid, remoteName);
      const match = testReportGlob();

      const beforeEntries = await crashReportsService.ls('/', -1);
      expect(beforeEntries).to.include(remotePath);

      await crashReportsService.pull(tempDir, '/', {
        erase: true,
        match,
      });

      const files = await listFilesRecursive(tempDir);
      expect(files.length).to.be.greaterThan(0);
      expect(
        files.every((file) => path.basename(file).includes(TEST_REPORT_STEM)),
      ).to.be.true;

      const afterEntries = await crashReportsService.ls('/', -1);
      expect(afterEntries).to.not.include(remotePath);
    });
  });

  describe('clear', function () {
    it('should clear all crash reports without error', async function () {
      await crashReportsService.clear();

      const afterEntries = await crashReportsService.ls('/', 2);
      const unexpectedEntries = afterEntries.filter(
        (entry) => !entry.includes('com.apple.appstored'),
      );

      expect(
        unexpectedEntries,
        `Unexpected crash report entries found: ${unexpectedEntries.join(', ')}`,
      ).to.be.empty;
    });

    it('should be idempotent, clearing empty directory should not error', async function () {
      await crashReportsService.clear();
      await crashReportsService.clear();
    });
  });
});
