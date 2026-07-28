import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, beforeEach, describe, it} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import {logger} from '@appium/support';
import {expect} from 'chai';

import {Services} from '../../src/index.js';
import type {CrashReport, CrashReportsService, DVTInstruments} from '../../src/index.js';
import {AfcService} from '../../src/services/ios/afc/index.js';
import {CoreDeviceService} from '../../src/services/ios/core-device/core-device-service.js';
import {CrashReportsService as CrashReportsServiceClass} from '../../src/services/ios/crash-reports/index.js';
import {MessageAux} from '../../src/services/ios/dvt/dtx-message.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('CrashReportsService.test');
log.level = 'debug';

const TEST_REPORT_STEM = 'remotexpc-integration-test';

const {SIGSEGV} = os.constants.signals;

/** App launched to obtain a valid PID for the crash-inducing DTX message */
const CRASH_HELPER_BUNDLE_ID = 'com.apple.calculator';

/** Process whose crash report the watch test waits for */
const CRASH_TARGET_PROCESS_NAME = 'DTServiceHub';

/**
 * Minimal client for the CoreDevice diagnostics service, used only to trigger a
 * sysdiagnose remotely so the test does not need physical key presses.
 */
class SysdiagnoseTrigger extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.diagnosticsservice';

  constructor(udid: string) {
    super(udid, SysdiagnoseTrigger.RSD_SERVICE_NAME);
  }

  /** Resolves once the device finishes creating the sysdiagnose archive */
  async capture(timeoutMs: number): Promise<void> {
    await this.invoke(
      'com.apple.coredevice.feature.capturesysdiagnose',
      {options: {collectFullLogs: true}, isDryRun: false},
      {timeoutMs},
    );
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
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

async function writeTestCrashReport(udid: string, remoteFileName: string): Promise<void> {
  const afc = new AfcService(udid, true, CrashReportsServiceClass.RSD_COPY_MOBILE_NAME);
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

describe('Crash Reports Service', {timeout: 120000}, function () {
  let udid: string;

  let crashReportsService: CrashReportsService;

  before(async function () {
    udid = requireDeviceUdid();

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
        await fs.rm(tempDir, {recursive: true, force: true});
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

      await crashReportsService.pull(tempDir, '/', {match});

      const files = await listFilesRecursive(tempDir);
      expect(files.length).to.be.greaterThan(0);
      expect(files.every((file) => path.basename(file).includes(TEST_REPORT_STEM))).to.be.true;
    });
  });

  describe('integration workflow', function () {
    let tempDir: string;

    beforeEach(async function () {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crash-workflow-'));
    });

    afterEach(async function () {
      try {
        await fs.rm(tempDir, {recursive: true, force: true});
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
      expect(files.every((file) => path.basename(file).includes(TEST_REPORT_STEM))).to.be.true;

      const afterEntries = await crashReportsService.ls('/', -1);
      expect(afterEntries).to.not.include(remotePath);
    });
  });

  describe('clear', function () {
    it('should clear all crash reports without error', async function () {
      await crashReportsService.clear();

      const afterEntries = await crashReportsService.ls('/', 2);
      const unexpectedEntries = afterEntries.filter((entry) => !entry.includes('com.apple.appstored'));

      expect(unexpectedEntries, `Unexpected crash report entries found: ${unexpectedEntries.join(', ')}`).to.be.empty;
    });

    it('should be idempotent, clearing empty directory should not error', async function () {
      await crashReportsService.clear();
      await crashReportsService.clear();
    });
  });
});

// The advanced methods are slow (the OS takes minutes to produce a crash report or
// sysdiagnose) and need extra device capabilities, so they live in their own suite with a
// generous timeout and are opt-in via env vars. Keeping them out of the main suite means a
// hung advanced test cannot cancel the fast tests, and vice versa.
describe('Crash Reports Service (advanced)', {timeout: 25 * 60 * 1000}, function () {
  let udid: string;
  let crashReportsService: CrashReportsService;

  before(async function () {
    udid = requireDeviceUdid();
    crashReportsService = await Services.startCrashReportsService(udid);
  });

  after(async function () {
    try {
      crashReportsService?.close();
    } catch {}
  });

  describe('watch', function () {
    // Inducing a real crash needs the DVT service (developer disk image mounted) and the
    // OS takes ~2 min to write and flush the report, so this is opt-in.
    const skip = process.env.WATCH_E2E ? false : 'set WATCH_E2E=1 to run this (slow) test';

    it('should yield the crash report of a crashed process', {skip}, async function (t) {
      let dvt: DVTInstruments;
      try {
        dvt = await Services.startDVTService(udid);
      } catch (error) {
        t.skip(`DVT service unavailable (is the developer disk image mounted?): ${error}`);
        return;
      }

      const watchAbort = new AbortController();
      const watcher = crashReportsService.watch({
        signal: watchAbort.signal,
        processName: CRASH_TARGET_PROCESS_NAME,
      });
      let pendingReport: Promise<IteratorResult<CrashReport, void>> | undefined;
      try {
        // The generator connects lazily on the first next(); prime it and give the
        // syslog capture a moment to start before inducing the crash
        pendingReport = watcher.next();
        await delay(5000);

        const pid = await dvt.processControl.launch({
          bundleId: CRASH_HELPER_BUNDLE_ID,
          killExisting: true,
        });
        expect(pid).to.be.greaterThan(0);

        // Modern iOS rejects crash-inducing signals ("Unsupported signal"), so no app
        // crash can be triggered directly. Instead, crash the DVT service hub itself:
        // sendSignal:toPid: with raw int32 auxiliaries (instead of archived objects) is
        // malformed and reliably crashes DTServiceHub, producing a genuine .ips report.
        // The hub is respawned on demand, so this leaves no lasting damage.
        try {
          const processControl = dvt.processControl as any;
          await processControl.initialize();
          const channel = processControl.requireChannel();
          await channel.call('sendSignal_toPid_')(new MessageAux().appendInt(SIGSEGV).appendInt(pid));
          await channel.receivePlist();
        } catch {
          // The DVT connection drops when the hub crashes - expected
        }
        log.debug(`Crashed ${CRASH_TARGET_PROCESS_NAME} to induce a crash report`);

        // pendingReport is the primed iteration; it resolves with the first matching report
        const {value: report, done} = await pendingReport;
        if (done || !report) {
          throw new Error('watch() ended unexpectedly');
        }
        log.debug(`watch() yielded report: ${report.filename} (process: ${report.metadata?.name})`);
        expect(report.filename).to.match(/\.(ips|panic)$/);
        expect(report.raw).to.not.be.empty;
        expect(report.metadata?.name).to.equal(CRASH_TARGET_PROCESS_NAME);
      } finally {
        // Aborting settles a pending iteration even while the watcher is between reports
        watchAbort.abort();
        try {
          await pendingReport;
        } catch {}
        try {
          await watcher.return();
        } catch {}
        try {
          await dvt.dvtService.close();
        } catch {}
      }
    });
  });

  describe('getNewSysdiagnose', function () {
    // Creating a sysdiagnose takes several minutes on-device; opt in explicitly
    const skip = process.env.SYSDIAGNOSE_E2E ? false : 'set SYSDIAGNOSE_E2E=1 to run this (slow) test';
    const sysdiagnoseTimeoutMs = 20 * 60 * 1000;

    it('should pull a newly created sysdiagnose archive', {skip}, async function (t) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sysdiagnose-test-'));
      const trigger = new SysdiagnoseTrigger(udid);

      // Fire the trigger without awaiting: the invocation only resolves after the archive
      // is complete (or rejects — including when getNewSysdiagnose erases the archive out
      // from under the trigger's own transfer). Capture its outcome so an EARLY rejection
      // (e.g. com.apple.coredevice.diagnosticsservice not in this tunnel's catalog / DDI
      // not mounted) can be surfaced instead of letting getNewSysdiagnose poll to timeout.
      let triggerError: Error | undefined;
      const capturePromise = trigger.capture(sysdiagnoseTimeoutMs).catch((error: unknown) => {
        triggerError = error as Error;
      });

      // A sysdiagnose that started will have created an in-progress temp file within a few
      // seconds; an unavailable trigger service rejects almost immediately. If the trigger
      // fails this fast, it never started a sysdiagnose, so skip rather than time out.
      await Promise.race([capturePromise, delay(8000)]);
      if (triggerError) {
        t.skip(
          `Sysdiagnose could not be triggered (is the CoreDevice diagnostics service in the catalog / DDI mounted?): ${triggerError.message}`,
        );
        return;
      }

      try {
        await crashReportsService.getNewSysdiagnose(tempDir, {timeoutMs: sysdiagnoseTimeoutMs - 60000});

        const files = await fs.readdir(tempDir);
        log.debug(`Pulled sysdiagnose files: ${files.join(', ')}`);
        const archive = files.find((file) => file.startsWith('sysdiagnose_') && file.endsWith('.tar.gz'));
        expect(archive, 'a sysdiagnose_*.tar.gz archive should have been pulled').to.not.be.undefined;
        const {size} = await fs.stat(path.join(tempDir, archive!));
        expect(size).to.be.greaterThan(1024 * 1024);
      } finally {
        await trigger.close().catch(() => {});
        await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
      }
    });
  });
});
