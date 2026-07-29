import {describe, it} from 'node:test';

import {expect} from 'chai';

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

    expect(metadata).to.not.be.undefined;
    expect(metadata?.name).to.equal('SampleApp');
    expect(metadata?.bugType).to.equal('309');
    expect(metadata?.timestamp).to.equal('2026-07-14 12:00:00.00 +0530');
    expect(metadata?.incidentId).to.equal('AAAA-BBBB');
    expect(metadata?.osVersion).to.equal('iPhone OS 26.0 (23A100)');
  });

  it('should parse a header without a trailing newline', function () {
    const metadata = parseCrashReportMetadata('{"name":"foo","bug_type":"298"}');
    expect(metadata?.name).to.equal('foo');
    expect(metadata?.bugType).to.equal('298');
  });

  it('should leave missing fields undefined', function () {
    const metadata = parseCrashReportMetadata('{"bug_type":"309"}\nrest');
    expect(metadata).to.not.be.undefined;
    expect(metadata?.name).to.be.undefined;
    expect(metadata?.incidentId).to.be.undefined;
  });

  it('should return undefined for a non-JSON header', function () {
    expect(parseCrashReportMetadata('Incident Identifier: AAAA\nProcess: foo')).to.be.undefined;
  });

  it('should return undefined for a non-object JSON header', function () {
    expect(parseCrashReportMetadata('["array"]\nbody')).to.be.undefined;
    expect(parseCrashReportMetadata('42\nbody')).to.be.undefined;
    expect(parseCrashReportMetadata('null\nbody')).to.be.undefined;
  });

  it('should ignore non-string values for known fields', function () {
    const metadata = parseCrashReportMetadata('{"name":42,"bug_type":"309"}\n');
    expect(metadata?.name).to.be.undefined;
    expect(metadata?.bugType).to.equal('309');
  });
});

describe('extractSavedReportFileName', function () {
  it('should extract the report file name from a saved-report announcement', function () {
    const fileName = extractSavedReportFileName(createSyslogEntry());
    expect(fileName).to.equal('SampleApp-2026-07-14-120000.ips');
  });

  it('should accept .panic reports', function () {
    const entry = createSyslogEntry({
      message: "Saved type '210' report at /var/mobile/Library/Logs/CrashReporter/kernel-2026-07-14-120000.panic",
    });
    expect(extractSavedReportFileName(entry)).to.equal('kernel-2026-07-14-120000.panic');
  });

  it('should ignore entries from other processes', function () {
    const entry = createSyslogEntry({filename: '/usr/libexec/otherd'});
    expect(extractSavedReportFileName(entry)).to.be.undefined;
  });

  it('should ignore entries from other images', function () {
    const entry = createSyslogEntry({imageName: '/usr/lib/libSystem.dylib'});
    expect(extractSavedReportFileName(entry)).to.be.undefined;
  });

  it('should ignore non saved-report messages', function () {
    const entry = createSyslogEntry({message: 'some unrelated log line'});
    expect(extractSavedReportFileName(entry)).to.be.undefined;
  });

  it('should ignore reports with other extensions', function () {
    const entry = createSyslogEntry({
      message: "Saved type '298' report at /var/mobile/Library/Logs/CrashReporter/log.txt",
    });
    expect(extractSavedReportFileName(entry)).to.be.undefined;
  });
});
