import { logger } from '@appium/support';
import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Services } from '../../src/index.js';
import type { CrashReportsService } from '../../src/index.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

// the match pattern option in pull might need to be adjusted based on actual crash report names on the device
// use ls to find reports and adjust accordingly
describe('Crash Reports Service', function () {
  this.timeout(120000); // pulling crash reports can take time

  const udid = process.env.UDID || '';

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
      await crashReportsService.pull(tempDir, '/', {
        match: '**WebKit.WebContent*.ips',
      });

      await fs.access(tempDir);
      const entries = await fs.readdir(tempDir);

      expect(entries.every((entry) => entry.includes('WebKit.WebContent'))).to
        .be.true;
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

      await crashReportsService.pull(tempDir, '/', {
        erase: true,
        match: '**/SiriSearchFeedback*.ips',
      });

      await fs.access(tempDir);
      const entries = await fs.readdir(tempDir);
      expect(entries.every((entry) => entry.includes('SiriSearchFeedback'))).to
        .be.true;

      const afterEntries = await crashReportsService.ls('/', 2);
      const hasSiriSearchFeedback = afterEntries.some((entry) =>
        entry.includes('SiriSearchFeedback'),
      );
      expect(hasSiriSearchFeedback).to.be.false;
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
