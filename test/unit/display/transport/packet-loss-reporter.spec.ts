import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PacketLossReporter} from '../../../../src/services/ios/display/transport/packet-loss-reporter.js';

/** Captures the debug lines a reporter emits. */
function recordingLogger(): {lines: string[]; log: {debug(message: string): void}} {
  const lines: string[] = [];
  return {lines, log: {debug: (message: string): void => void lines.push(message)}};
}

// The reporter reads performance.now() directly, so a long interval is the way
// to pin it to "first line only" and a zero interval to "every line".
const NEVER_AGAIN = 60_000;
const ALWAYS = 0;

describe('PacketLossReporter', function () {
  it('reports the first gap immediately', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'video', {intervalMs: NEVER_AGAIN});

    reporter.record(3, 1200);

    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('video RTP gap'));
    assert.ok(lines[0].includes('3 packet(s)'));
    assert.ok(lines[0].includes('before sequence 1200'));
  });

  it('holds back later gaps inside the interval', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'audio', {intervalMs: NEVER_AGAIN});

    for (let i = 0; i < 500; i++) {
      reporter.record(1, i);
    }

    // The flood this exists to prevent: one line, not five hundred.
    assert.strictEqual(lines.length, 1);
  });

  it('accumulates the suppressed gaps into the next line', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'audio', {intervalMs: NEVER_AGAIN});

    reporter.record(2, 10);
    reporter.record(5, 20);
    reporter.record(3, 30);
    reporter.flush();

    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes('8 packet(s)'));
    assert.ok(lines[1].includes('2 gap(s)'));
  });

  it('includes running totals once it has suppressed anything', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'audio', {intervalMs: NEVER_AGAIN});

    reporter.record(4, 10);
    reporter.record(6, 20);
    reporter.flush();

    // The first line covers everything so far, so totals would be noise.
    assert.ok(!lines[0].includes('so far'));
    assert.ok(lines[1].includes('10 packet(s) in 2 gap(s) so far'));
  });

  it('reports every gap when the interval is zero', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'video', {intervalMs: ALWAYS});

    reporter.record(1, 1);
    reporter.record(1, 2);
    reporter.record(1, 3);

    assert.strictEqual(lines.length, 3);
  });

  it('stays silent when flushed with nothing pending', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'video', {intervalMs: ALWAYS});

    reporter.flush();
    reporter.record(1, 1);
    reporter.flush();

    // Only the recorded gap; flush must never emit an empty summary.
    assert.strictEqual(lines.length, 1);
  });

  it('says nothing at all when no packets are lost', function () {
    const {lines, log} = recordingLogger();
    const reporter = new PacketLossReporter(log as never, 'video');

    reporter.flush();

    assert.strictEqual(lines.length, 0);
  });
});
