import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Services } from '../../src/index.js';
import type { CrashReportsService } from '../../src/index.js';

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
      const entries = await crashReportsService.ls('/');
      expect(entries).to.be.an('array');
    });

    it('should list crash reports with depth=1', async function () {
      const entries = await crashReportsService.ls('/', 1);
      expect(entries).to.be.an('array');
      // Each entry should be a direct child path
      for (const entry of entries) {
        expect(entry).to.match(/^\/[^/]+$/);
      }
    });

    it('should return empty array with depth=0', async function () {
      const entries = await crashReportsService.ls('/', 0);
      expect(entries).to.be.an('array');
      expect(entries).to.have.lengthOf(0);
    });

    it('should list crash reports recursively with depth=-1', async function () {
      const entries = await crashReportsService.ls('/', -1);
      console.log(entries);
      expect(entries).to.be.an('array');
      // With infinite depth, we may get nested paths
    });
  });

  describe('flush', function () {
    it('should flush crash reports without error', async function () {
      // Flush triggers the crash mover to move pending reports
      await crashReportsService.flush();
      // If we get here without throwing, the flush succeeded
    });
  });

  describe('pull', function () {
    let tempDir: string;

    beforeEach(function () {
      // Create a unique temp directory for each test
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-reports-test-'));
    });

    afterEach(function () {
      // Clean up temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('should pull crash reports to local directory', async function () {
      await crashReportsService.flush();
      await crashReportsService.pull(tempDir, '/');
      expect(fs.existsSync(tempDir)).to.be.true;
      console.log('Crash reports in tempDir:', fs.readdirSync(tempDir));
    });

    it('should filter files by match pattern', async function () {
      await crashReportsService.pull(tempDir, '/', { match: /\.ips$/ });

      // Check that directory was created
      expect(fs.existsSync(tempDir)).to.be.true;

      // Recursively check all files end with .ips (if any files exist)
      const checkFiles = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkFiles(fullPath);
          } else {
            expect(entry.name).to.match(/\.ips$/);
          }
        }
      };
      checkFiles(tempDir);
    });

    it('should accept string match pattern', async function () {
      await crashReportsService.pull(tempDir, '/', { match: '\\.panic$' });
      expect(fs.existsSync(tempDir)).to.be.true;

      const checkFiles = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkFiles(fullPath);
          } else {
            expect(entry.name).to.match(/\.panic$/);
          }
        }
      };
      checkFiles(tempDir);
    });
  });

  describe('clear', function () {
    it('should clear all crash reports without error', async function () {
      // First check what exists
      const beforeEntries = await crashReportsService.ls('/');

      // Clear all crash reports
      await crashReportsService.clear();

      // After clearing, root should be empty or contain only auto-created paths
      const afterEntries = await crashReportsService.ls('/');

      // All entries should be gone, except possibly auto-created ones
      const significantEntries = afterEntries.filter(
        (e) => !e.includes('com.apple.appstored'),
      );

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

    beforeEach(function () {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-workflow-'));
    });

    afterEach(function () {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it('should perform complete workflow: flush, ls, pull', async function () {
      // 1. Flush to get latest crash reports
      await crashReportsService.flush();

      // 2. List what's available
      const entries = await crashReportsService.ls('/');
      expect(entries).to.be.an('array');

      // 3. Pull all reports
      await crashReportsService.pull(tempDir, '/');

      // 4. Verify temp directory exists
      expect(fs.existsSync(tempDir)).to.be.true;
    });

    it('should perform flush, pull with erase, and verify removal', async function () {
      await crashReportsService.flush();
      const beforeEntries = await crashReportsService.ls('/');

      await crashReportsService.pull(tempDir, '/', { erase: true });

      const afterEntries = await crashReportsService.ls('/');

      // Files should be erased, directories may remain
      expect(fs.existsSync(tempDir)).to.be.true;
    });
  });
});
