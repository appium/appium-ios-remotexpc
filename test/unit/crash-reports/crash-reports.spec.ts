import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {extractSavedReportFileName, parseCrashReportMetadata} from '../../../src/services/ios/crash-reports/index.js';
import type {SyslogEntry} from '../../../src/services/ios/syslog-service/syslog-entry-parser.js';

function createSyslogEntry(overrides: Partial<SyslogEntry> = {}): SyslogEntry {
  return {
    pid: 100,
    timestamp: new Date(),
    timestampSeconds: 1700000000,
    timestampMicroseconds: 0,
    level: 0,
    levelName: 'NOTICE',
    imageName: '/System/Library/PrivateFrameworks/OSAnalytics.framework/OSAnalytics',
    imageOffset: 0,
    filename: '/usr/libexec/osanalyticshelper',
    message:
      "Saved type '309' report (2 of max 25) at /var/mobile/Library/Logs/CrashReporter/SampleApp-2026-07-14-120000.ips",
    ...overrides,
  };
}

describe('parseCrashReportMetadata', function () {
  it('should parse the single-line JSON header of an .ips report', function () {
    const raw =
      '{"app_name":"SampleApp","timestamp":"2026-07-14 12:00:00.00 +0530","name":"SampleApp",' +
      '"bug_type":"309","os_version":"iPhone OS 26.0 (23A100)","incident_id":"AAAA-BBBB"}\n' +
      '{"procName":"SampleApp","pid":4242}\n';

    const metadata = parseCrashReportMetadata(raw);

    assert.notStrictEqual(metadata, undefined);
    assert.strictEqual(metadata?.name, 'SampleApp');
    assert.strictEqual(metadata?.bugType, '309');
    assert.strictEqual(metadata?.timestamp, '2026-07-14 12:00:00.00 +0530');
    assert.strictEqual(metadata?.incidentId, 'AAAA-BBBB');
    assert.strictEqual(metadata?.osVersion, 'iPhone OS 26.0 (23A100)');
  });

  it('should parse a header without a trailing newline', function () {
    const metadata = parseCrashReportMetadata('{"name":"foo","bug_type":"298"}');
    assert.strictEqual(metadata?.name, 'foo');
    assert.strictEqual(metadata?.bugType, '298');
  });

  it('should leave missing fields undefined', function () {
    const metadata = parseCrashReportMetadata('{"bug_type":"309"}\nrest');
    assert.notStrictEqual(metadata, undefined);
    assert.strictEqual(metadata?.name, undefined);
    assert.strictEqual(metadata?.incidentId, undefined);
  });

  it('should return undefined for a non-JSON header', function () {
    assert.strictEqual(parseCrashReportMetadata('Incident Identifier: AAAA\nProcess: foo'), undefined);
  });

  it('should return undefined for a non-object JSON header', function () {
    assert.strictEqual(parseCrashReportMetadata('["array"]\nbody'), undefined);
    assert.strictEqual(parseCrashReportMetadata('42\nbody'), undefined);
    assert.strictEqual(parseCrashReportMetadata('null\nbody'), undefined);
  });

  it('should ignore non-string values for known fields', function () {
    const metadata = parseCrashReportMetadata('{"name":42,"bug_type":"309"}\n');
    assert.strictEqual(metadata?.name, undefined);
    assert.strictEqual(metadata?.bugType, '309');
  });
});

describe('extractSavedReportFileName', function () {
  it('should extract the report file name from a saved-report announcement', function () {
    const fileName = extractSavedReportFileName(createSyslogEntry());
    assert.strictEqual(fileName, 'SampleApp-2026-07-14-120000.ips');
  });

  it('should accept .panic reports', function () {
    const entry = createSyslogEntry({
      message: "Saved type '210' report at /var/mobile/Library/Logs/CrashReporter/kernel-2026-07-14-120000.panic",
    });
    assert.strictEqual(extractSavedReportFileName(entry), 'kernel-2026-07-14-120000.panic');
  });

  it('should ignore entries from other processes', function () {
    const entry = createSyslogEntry({filename: '/usr/libexec/otherd'});
    assert.strictEqual(extractSavedReportFileName(entry), undefined);
  });

  it('should ignore entries from other images', function () {
    const entry = createSyslogEntry({imageName: '/usr/lib/libSystem.dylib'});
    assert.strictEqual(extractSavedReportFileName(entry), undefined);
  });

  it('should ignore non saved-report messages', function () {
    const entry = createSyslogEntry({message: 'some unrelated log line'});
    assert.strictEqual(extractSavedReportFileName(entry), undefined);
  });

  it('should ignore reports with other extensions', function () {
    const entry = createSyslogEntry({
      message: "Saved type '298' report at /var/mobile/Library/Logs/CrashReporter/log.txt",
    });
    assert.strictEqual(extractSavedReportFileName(entry), undefined);
  });
});
