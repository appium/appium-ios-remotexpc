import {on} from 'node:events';
import fs from 'node:fs/promises';
import posixpath from 'node:path/posix';
import {setTimeout as delay} from 'node:timers/promises';

import {createLockdownServiceForTunnel} from '../../../lib/lockdown/index.js';
import {getLogger} from '../../../lib/logger.js';
import {DEFAULT_TUNNEL_SERVICE_WAIT_MS, resolveTunnelService} from '../../../lib/tunnel/tunnel-service-resolver.js';
import type {
  CrashReport,
  CrashReportMetadata,
  CrashReportsPullOptions,
  CrashReportsWatchOptions,
  SysdiagnoseOptions,
} from '../../../lib/types.js';
import {createRawServiceSocket, readExact} from '../afc/codec.js';
import {AfcService} from '../afc/index.js';
import {NotificationProxyService} from '../notification-proxy/index.js';
import SyslogService from '../syslog-service/index.js';
import type {SyslogEntry} from '../syslog-service/syslog-entry-parser.js';

const log = getLogger('CrashReportsService');

/**
 * Path that is sometimes auto-created after deletion
 */
const APPSTORED_PATH = '/com.apple.appstored';

/** Process that announces newly saved crash reports in the syslog */
const OS_ANALYTICS_PROCESS = 'osanalyticshelper';

/** Image that emits the crash report creation syslog lines */
const OS_ANALYTICS_IMAGE = 'OSAnalytics';

/** Syslog message prefix announcing a newly saved crash report */
const CRASH_REPORT_SAVED_PREFIX = 'Saved type ';

/** File extensions of crash report products announced via syslog */
const CRASH_REPORT_EXTENSIONS = ['.ips', '.panic'];

/** os_trace relay shim used to monitor syslog for crash report creation */
const OS_TRACE_RELAY_SERVICE_NAME = 'com.apple.os_trace_relay.shim.remote';

/** Directory (relative to the crash reports root) where sysdiagnose archives are created */
const SYSDIAGNOSE_DIR = 'DiagnosticLogs/sysdiagnose';

/** Notification posted by the device when a sysdiagnose has finished */
const SYSDIAGNOSE_STOPPED_NOTIFICATION = 'com.apple.sysdiagnose.sysdiagnoseStopped';

/** Marker contained in the filename of a sysdiagnose archive that is still being written */
const IN_PROGRESS_SYSDIAGNOSE_PREFIX = 'IN_PROGRESS_';

/** Possible extensions of an in-progress sysdiagnose archive */
const IN_PROGRESS_SYSDIAGNOSE_EXTENSIONS = ['.tmp', '.tar.gz'];

/** In-progress sysdiagnose files older than this (device clock) are considered leftovers */
const SYSDIAGNOSE_IN_PROGRESS_MAX_TTL_MS = 600_000;

/** iOS 17+ needs a moment after the stop notification before the archive is readable */
const SYSDIAGNOSE_SETTLE_DELAY_MS = 3000;

/** Interval between listings while waiting for an in-progress sysdiagnose to appear */
const SYSDIAGNOSE_POLL_INTERVAL_MS = 100;

/** Interval between checks for the finished archive to appear after the stop notification */
const SYSDIAGNOSE_ARCHIVE_POLL_INTERVAL_MS = 500;

/** Interval between attempts to read a crash report that was just announced */
const REPORT_READ_RETRY_INTERVAL_MS = 100;

/** Default limit for how long to retry reading a newly announced crash report */
const DEFAULT_REPORT_READ_TIMEOUT_MS = 10_000;

/** Receive timeout used when waiting indefinitely for a notification (24h) */
const INDEFINITE_RECEIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * CrashReportsService provides an API to:
 * - List crash reports on the device (ls)
 * - Pull crash reports from the device to the local machine (pull)
 * - Clear all crash reports from the device (clear)
 * - Flush crash report products into CrashReports directory (flush)
 *
 * This service uses the com.apple.crashreportcopymobile.shim.remote for AFC operations
 * and com.apple.crashreportmover.shim.remote for flush operations.
 */
export class CrashReportsService {
  static readonly RSD_COPY_MOBILE_NAME = 'com.apple.crashreportcopymobile.shim.remote';
  static readonly RSD_CRASH_MOVER_NAME = 'com.apple.crashreportmover.shim.remote';

  private afc: AfcService;

  constructor(private readonly udid: string) {
    this.afc = new AfcService(udid, true, CrashReportsService.RSD_COPY_MOBILE_NAME);
  }

  /**
   * List files and folders in the crash report's directory.
   * @param dirPath Path to list, relative to the crash report's directory. Defaults to "/"
   * @param depth Listing depth. 1 for immediate children, -1 (or any negative number) for infinite depth
   * @returns List of file paths listed
   */
  async ls(dirPath = '/', depth = 1): Promise<string[]> {
    if (depth === 0) {
      return [];
    }

    const results: string[] = [];
    const entries = await this.afc.listdir(dirPath);

    for (const entry of entries) {
      const entryPath = posixpath.join(dirPath, entry);
      results.push(entryPath);

      if (depth !== 1) {
        try {
          if (await this.afc.isdir(entryPath)) {
            const newDepth = depth < 0 ? -1 : depth - 1;
            const subEntries = await this.ls(entryPath, newDepth);
            results.push(...subEntries);
          }
        } catch {
          // Skip entries we can't access
        }
      }
    }

    return results;
  }

  /**
   * Pull crash reports from the device to the local machine.
   * @param out Local directory path
   * @param entry Remote path on device, defaults to "/"
   * @param options Pull options (erase, match pattern)
   */
  async pull(out: string, entry = '/', options?: CrashReportsPullOptions): Promise<void> {
    const {erase = false, match} = options ?? {};

    log.debug(`Pulling crash reports from '${entry}' to '${out}', erase: ${erase}`);

    await fs.mkdir(out, {recursive: true});

    await this.afc.pull(entry, out, {
      recursive: true,
      match,
      callback: erase ? async (remotePath) => void (await this.afc.rmSingle(remotePath, true)) : undefined,
    });
  }

  /**
   * Clear all crash reports from the device.
   * Removes all files and folders from the crash reports directory.
   * @throws Error if some items could not be deleted (except for auto-created paths)
   */
  async clear(): Promise<void> {
    log.debug('Clearing all crash reports');

    const entries = await this.afc.listdir('/');
    const nonDeletedItems: string[] = [];

    for (const entry of entries) {
      const fullPath = posixpath.join('/', entry);
      const failedPaths = await this.afc.rm(fullPath, true);
      nonDeletedItems.push(...failedPaths);
    }

    // Filter out special paths that are auto-created
    const realFailures = nonDeletedItems.filter((item) => item !== APPSTORED_PATH);

    if (realFailures.length > 0) {
      throw new Error(`Failed to clear crash reports directory, undeleted items: ${realFailures.join(', ')}`);
    }

    log.debug('Successfully cleared all crash reports');
  }

  /**
   * Trigger com.apple.crashreportmover to flush all products into CrashReports directory
   */
  async flush(): Promise<void> {
    log.debug('Flushing crash reports');

    const {host, port} = await resolveTunnelService(this.udid, CrashReportsService.RSD_CRASH_MOVER_NAME, {
      waitMs: DEFAULT_TUNNEL_SERVICE_WAIT_MS,
    });

    const socket = await createRawServiceSocket(host, port);
    try {
      const ack = await readExact(socket, 5, 10000);
      const expectedAck = Buffer.from('ping\0', 'utf8');
      if (!ack.equals(expectedAck)) {
        throw new Error(
          `Unexpected flush acknowledgment. Expected: ${expectedAck.toString('hex')}, Got: ${ack.toString('hex')}`,
        );
      }
      log.debug('Successfully flushed crash reports');
    } finally {
      socket.destroy();
    }
  }

  /**
   * Monitor creation of new crash reports and yield each one as it is saved.
   *
   * Watches the device syslog for `osanalyticshelper` "Saved type" messages, reads the
   * referenced `.ips`/`.panic` file (retrying until it becomes readable) and yields it.
   * Runs until the consumer stops iterating.
   * @param options Watch options (process name filter, per-report read timeout)
   * @returns Async generator yielding newly created crash reports
   */
  async *watch(options?: CrashReportsWatchOptions): AsyncGenerator<CrashReport, void, void> {
    const {processName, readTimeoutMs = DEFAULT_REPORT_READ_TIMEOUT_MS, signal} = options ?? {};

    const {port} = await resolveTunnelService(this.udid, OS_TRACE_RELAY_SERVICE_NAME, {
      waitMs: DEFAULT_TUNNEL_SERVICE_WAIT_MS,
    });

    const syslog = new SyslogService(this.udid);
    const abortController = new AbortController();
    const iterationSignal =
      signal === undefined ? abortController.signal : AbortSignal.any([signal, abortController.signal]);
    // Attach the listener before starting the capture so no entry is missed
    const syslogEntries = on(syslog, 'syslogEntry', {signal: iterationSignal}) as AsyncIterableIterator<[SyslogEntry]>;
    await syslog.start({serviceName: OS_TRACE_RELAY_SERVICE_NAME, port: String(port)});

    try {
      for await (const [entry] of syslogEntries) {
        const reportFileName = extractSavedReportFileName(entry);
        if (reportFileName === undefined) {
          continue;
        }
        log.debug(`New crash report announced: ${reportFileName}`);

        // Reports can be minutes or hours apart; the AFC connection may have been dropped
        // while idle between them (AfcService does not auto-reconnect), so renew it before
        // reading.
        this.renewAfcConnection();

        const report = await this.readReportWhenAvailable(reportFileName, readTimeoutMs);
        if (report === undefined) {
          log.warn(`Crash report '${reportFileName}' did not become readable within ${readTimeoutMs}ms, skipping`);
          continue;
        }

        if (processName === undefined || report.metadata?.name === processName) {
          yield report;
        }
      }
    } finally {
      abortController.abort();
      await syslog.stop();
    }
  }

  /**
   * Monitor the creation of a new sysdiagnose archive and pull it once complete.
   *
   * The sysdiagnose must be triggered on the device (press Power + VolUp + VolDown for
   * about 0.215 seconds); this method then waits for the in-progress archive to appear,
   * waits for the completion notification and pulls the finished archive.
   * @param out Local directory to pull the sysdiagnose archive into
   * @param options Sysdiagnose options (erase after pulling, timeout)
   */
  async getNewSysdiagnose(out: string, options?: SysdiagnoseOptions): Promise<void> {
    const {erase = true, timeoutMs} = options ?? {};
    const deadlineMs = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

    const archivePath = await this.waitForSysdiagnoseArchivePath(deadlineMs);
    log.info(`Sysdiagnose archive creation has been started: ${archivePath}`);

    await this.waitForSysdiagnoseToStop(deadlineMs);

    // The AFC connection sat idle during the (multi-minute) wait for the completion
    // notification, so the device may have dropped it. AfcService does not reconnect once a
    // connection is marked dead, so renew it before the remaining file operations.
    this.renewAfcConnection();

    // The stop notification can fire slightly before the device renames the in-progress
    // temp file to the final archive, so wait for the archive to actually appear.
    await this.waitForFileToExist(archivePath, deadlineMs);

    log.debug(`Pulling sysdiagnose archive '${archivePath}' to '${out}'`);
    await this.pull(out, archivePath, {erase});
  }

  /**
   * Close the service and release resources
   */
  close(): void {
    log.debug('Closing CrashReportsService');
    try {
      this.afc.close();
    } catch {}
  }

  /**
   * Read a crash report file, retrying until it becomes readable and its header parses.
   * Right after the syslog announcement the file may not exist yet or may only be
   * partially written.
   * @returns The report, or `undefined` if it could not be read before the timeout
   */
  private async readReportWhenAvailable(fileName: string, timeoutMs: number): Promise<CrashReport | undefined> {
    const deadlineMs = Date.now() + timeoutMs;
    let raw: string | undefined;

    do {
      try {
        raw = (await this.afc.getFileContents(`/${fileName}`)).toString('utf8');
        const metadata = parseCrashReportMetadata(raw);
        if (metadata !== undefined) {
          return {filename: fileName, raw, metadata};
        }
      } catch {
        // File does not exist yet or is not readable yet
      }
      await delay(REPORT_READ_RETRY_INTERVAL_MS);
    } while (Date.now() < deadlineMs);

    // Readable but with an unparseable header: yield it anyway rather than dropping it
    return raw === undefined ? undefined : {filename: fileName, raw};
  }

  /**
   * Poll the sysdiagnose directory until an in-progress archive appears and return the
   * path the finished archive will have.
   * In-progress files older than the TTL (by device clock) are ignored as leftovers of
   * previous runs.
   */
  private async waitForSysdiagnoseArchivePath(deadlineMs?: number): Promise<string> {
    const excludedStaleFiles = new Set<string>();
    let deviceClockOffsetMs: number | undefined;

    while (true) {
      let entries: string[] = [];
      try {
        entries = await this.afc.listdir(`/${SYSDIAGNOSE_DIR}`);
      } catch {
        // The sysdiagnose directory may not have been created yet
      }

      for (const filename of entries) {
        if (excludedStaleFiles.has(filename) || !filename.includes(IN_PROGRESS_SYSDIAGNOSE_PREFIX)) {
          continue;
        }
        const extension = IN_PROGRESS_SYSDIAGNOSE_EXTENSIONS.find((ext) => filename.endsWith(ext));
        if (extension === undefined) {
          continue;
        }

        let mtimeMs: number;
        try {
          mtimeMs = (await this.afc.stat(posixpath.join('/', SYSDIAGNOSE_DIR, filename))).st_mtime.getTime();
        } catch {
          // The in-progress file may have been renamed/removed between listing and stat
          continue;
        }

        deviceClockOffsetMs ??= await this.getDeviceClockOffsetMs();
        const ageMs = Date.now() + deviceClockOffsetMs - mtimeMs;
        if (ageMs >= SYSDIAGNOSE_IN_PROGRESS_MAX_TTL_MS) {
          log.warn(`Ignoring stale in-progress sysdiagnose file: ${filename}`);
          excludedStaleFiles.add(filename);
          continue;
        }

        log.debug(`Detected in-progress sysdiagnose: ${filename}`);
        const archiveName = `${filename
          .slice(0, filename.length - extension.length)
          .replace(IN_PROGRESS_SYSDIAGNOSE_PREFIX, '')}.tar.gz`;
        return posixpath.join('/', SYSDIAGNOSE_DIR, archiveName);
      }

      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new Error('Timed out waiting for an in-progress sysdiagnose archive to appear');
      }
      await delay(SYSDIAGNOSE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Wait for the device to post the sysdiagnose completion notification, then give the
   * archive a moment to settle.
   */
  private async waitForSysdiagnoseToStop(deadlineMs?: number): Promise<void> {
    const notificationProxy = new NotificationProxyService(this.udid);
    try {
      await notificationProxy.observe(SYSDIAGNOSE_STOPPED_NOTIFICATION);

      while (true) {
        const remainingMs = deadlineMs === undefined ? INDEFINITE_RECEIVE_TIMEOUT_MS : deadlineMs - Date.now();
        if (remainingMs <= 0) {
          throw new Error('Timed out waiting for sysdiagnose completion');
        }

        let notification;
        try {
          notification = await notificationProxy.expectNotification(remainingMs);
        } catch (error) {
          throw new Error(`Timed out waiting for sysdiagnose completion: ${(error as Error).message}`, {
            cause: error,
          });
        }

        if (notification.Name === SYSDIAGNOSE_STOPPED_NOTIFICATION) {
          log.debug('Sysdiagnose completion notification received');
          break;
        }
      }

      await delay(SYSDIAGNOSE_SETTLE_DELAY_MS);
    } finally {
      notificationProxy.close();
    }
  }

  /**
   * Replace the AFC connection with a fresh one. Used after long idle periods during which
   * the device may have dropped the connection (AfcService does not auto-reconnect once a
   * connection is marked dead).
   */
  private renewAfcConnection(): void {
    try {
      this.afc.close();
    } catch {}
    this.afc = new AfcService(this.udid, true, CrashReportsService.RSD_COPY_MOBILE_NAME);
  }

  /**
   * Poll until a file exists on the device, bounded by the optional deadline.
   * @throws Error if the file has not appeared by the deadline
   */
  private async waitForFileToExist(filePath: string, deadlineMs?: number): Promise<void> {
    while (!(await this.afc.exists(filePath))) {
      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new Error(`Timed out waiting for sysdiagnose archive to appear at '${filePath}'`);
      }
      await delay(SYSDIAGNOSE_ARCHIVE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Difference between the device wall clock and the local clock in milliseconds.
   * Falls back to 0 (assume synchronized clocks) if the device clock cannot be read.
   */
  private async getDeviceClockOffsetMs(): Promise<number> {
    try {
      const lockdown = await createLockdownServiceForTunnel(this.udid);
      try {
        return (await lockdown.getDeviceDate()).getTime() - Date.now();
      } finally {
        lockdown.close();
      }
    } catch (error) {
      log.warn(`Could not read the device clock, assuming it matches the local clock: ${error}`);
      return 0;
    }
  }
}

/**
 * Parse the header of a crash report (`.ips`/`.panic`) file.
 * Modern report files start with a single-line JSON header carrying the report metadata.
 * @returns The parsed metadata, or `undefined` if the header is not valid JSON
 */
export function parseCrashReportMetadata(raw: string): CrashReportMetadata | undefined {
  const newlineIndex = raw.indexOf('\n');
  const headerLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);

  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return undefined;
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return undefined;
  }

  const fields = header as Record<string, unknown>;
  const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return {
    name: asString(fields.name),
    bugType: asString(fields.bug_type),
    timestamp: asString(fields.timestamp),
    incidentId: asString(fields.incident_id),
    osVersion: asString(fields.os_version),
  };
}

/**
 * Extract the crash report file name from a syslog entry, if the entry announces a newly
 * saved crash report.
 * @returns The report file name, or `undefined` if the entry is not a report announcement
 */
export function extractSavedReportFileName(entry: SyslogEntry): string | undefined {
  if (
    posixpath.basename(entry.filename) !== OS_ANALYTICS_PROCESS ||
    posixpath.basename(entry.imageName) !== OS_ANALYTICS_IMAGE ||
    !entry.message.startsWith(CRASH_REPORT_SAVED_PREFIX)
  ) {
    return undefined;
  }

  const tokens = entry.message.trim().split(/\s+/);
  const reportFileName = posixpath.basename(tokens[tokens.length - 1]);
  if (!CRASH_REPORT_EXTENSIONS.includes(posixpath.extname(reportFileName))) {
    return undefined;
  }
  return reportFileName;
}

export default CrashReportsService;
