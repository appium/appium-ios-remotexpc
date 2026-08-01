import assert from 'node:assert/strict';
import {type TestContext, afterEach, beforeEach, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {DVTInstruments, SysmonProcessInfo, SysmonSample} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('Sysmontap.test');
log.level = 'debug';

/**
 * Collect up to `limit` process snapshots from the sysmontap instrument,
 * stopping the underlying stream once enough have been gathered.
 */
async function collectProcessSnapshots(
  sysmontap: DVTInstruments['sysmontap'],
  limit: number,
): Promise<SysmonProcessInfo[][]> {
  const snapshots: SysmonProcessInfo[][] = [];
  for await (const processes of sysmontap.iterProcesses()) {
    snapshots.push(processes);
    if (snapshots.length >= limit) {
      break;
    }
  }
  return snapshots;
}

describe('Sysmontap', {timeout: 60000}, function () {
  let udid: string;

  // A sysmontap instance supports a single sampling session per DVT connection,
  // so every test runs against its own freshly created connection.
  let dvt: DVTInstruments;

  beforeEach(async function () {
    udid = requireDeviceUdid();

    dvt = await Services.startDVTService(udid);
  });

  afterEach(async function () {
    if (dvt) {
      try {
        await dvt.sysmontap.stop();
      } catch {}
      try {
        await dvt.dvtService.close();
      } catch {}
    }
  });

  describe('Attribute discovery (DeviceInfo)', function () {
    it('should fetch sysmon process attributes', async function () {
      const attributes = await dvt.deviceInfo.sysmonProcessAttributes();

      assert.ok(Array.isArray(attributes));
      assert.ok(attributes.length > 0);
      attributes.forEach((attr) => assert.ok(typeof attr === 'string'));
      // 'pid' is always part of the per-process attribute set.
      assert.ok(attributes.includes('pid'));
      log.info(`process attributes (${attributes.length}):`, attributes);
    });

    it('should fetch sysmon system attributes', async function () {
      const attributes = await dvt.deviceInfo.sysmonSystemAttributes();

      assert.ok(Array.isArray(attributes));
      assert.ok(attributes.length > 0);
      attributes.forEach((attr) => assert.ok(typeof attr === 'string'));
      log.info(`system attributes (${attributes.length}):`, attributes);
    });
  });

  describe('Configuration', function () {
    it('should expose discovered attributes after configuring', async function () {
      const sysmontap = dvt.sysmontap;
      await sysmontap.configure({intervalMs: 1000});

      const processAttributes = sysmontap.getProcessAttributes();
      const systemAttributes = sysmontap.getSystemAttributes();

      assert.ok(Array.isArray(processAttributes));
      assert.ok(processAttributes.length > 0);
      assert.ok(Array.isArray(systemAttributes));
      assert.ok(systemAttributes.length > 0);
      assert.ok(processAttributes.includes('pid'));
    });
  });

  describe('Process sampling', function () {
    it('should stream labelled process snapshots through iterProcesses()', async function () {
      const sysmontap = dvt.sysmontap;

      const snapshots = await collectProcessSnapshots(sysmontap, 2);
      assert.ok(snapshots.length > 0);

      const processAttributes = sysmontap.getProcessAttributes();
      const populated = snapshots.find((snapshot) => snapshot.length > 0);
      assert.ok(populated !== null && populated !== undefined, 'expected at least one populated process snapshot');

      const processes = populated!;
      assert.ok(processes.length > 0);

      const sample = processes[0];
      assert.ok(typeof sample === 'object' && sample !== null && !Array.isArray(sample));
      // Every labelled record is keyed by the discovered attribute names and
      // exposes one value per attribute.
      const recordKeys = Object.keys(sample);
      assert.strictEqual(recordKeys.length, processAttributes.length);
      recordKeys.forEach((key) => assert.ok(processAttributes.includes(key)));
      assert.ok('pid' in sample);
      assert.ok(((v: unknown) => typeof v === 'number' || typeof v === 'bigint')(sample.pid));

      log.info(
        `received ${processes.length} processes; first record:`,
        JSON.stringify(sample, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)).slice(0, 400),
      );
    });

    it('should label process records in the configured attribute order (launchd is pid 1)', async function (ctx: TestContext) {
      const sysmontap = dvt.sysmontap;
      await sysmontap.configure();
      const processAttributes = sysmontap.getProcessAttributes();

      if (!processAttributes.includes('name') || !processAttributes.includes('pid')) {
        log.warn("'name'/'pid' attributes not present; skipping");
        ctx.skip();
        return;
      }

      const snapshots = await collectProcessSnapshots(sysmontap, 3);
      const allProcesses = snapshots.flat();
      assert.ok(allProcesses.length > 0);

      // Correctness check on the positional attribute mapping: pid 1 must be
      // launchd. This only holds if the DeviceInfo attribute order matches the
      // order of the streamed per-process value tuples.
      const launchd = allProcesses.find((proc) => proc.pid === 1);
      assert.ok(launchd !== null && launchd !== undefined, 'expected pid 1 in a snapshot');
      assert.strictEqual(launchd!.name, 'launchd');

      log.info('pid 1 record name:', launchd!.name);
    });
  });

  describe('Raw sample streaming', function () {
    it('should stream raw data samples (system and process) through messages()', async function () {
      const sysmontap = dvt.sysmontap;
      const samples: SysmonSample[] = [];
      const maxSamples = 4;

      for await (const sample of sysmontap.messages()) {
        samples.push(sample);
        if (samples.length >= maxSamples) {
          break;
        }
      }

      assert.strictEqual(samples.length, maxSamples);
      samples.forEach((sample) => assert.ok(typeof sample === 'object' && sample !== null && !Array.isArray(sample)));

      // Control/heartbeat frames are filtered out, so every yielded sample is
      // either a system sample or a process sample.
      samples.forEach((sample) =>
        assert.strictEqual(
          sample.Processes !== undefined || sample.System !== undefined,
          true,
          `sample keys: ${Object.keys(sample).join(', ')}`,
        ),
      );

      // Over a handful of samples we expect to observe both kinds.
      const hasSystem = samples.some((s) => s.System !== undefined);
      const hasProcesses = samples.some((s) => s.Processes !== undefined);
      log.info(`raw samples: system=${hasSystem}, processes=${hasProcesses}`);
    });

    it('should stream labelled system snapshots through iterSystem()', async function () {
      const sysmontap = dvt.sysmontap;

      let parsedSystem: Record<string, unknown> | null = null;
      for await (const system of sysmontap.iterSystem()) {
        parsedSystem = system;
        break;
      }

      assert.ok(parsedSystem !== null && parsedSystem !== undefined, 'expected to observe a system sample');
      const systemAttributes = sysmontap.getSystemAttributes();
      const keys = Object.keys(parsedSystem!);
      assert.strictEqual(keys.length, systemAttributes.length);
      keys.forEach((key) => assert.ok(systemAttributes.includes(key)));
      log.info('parsed system sample keys:', keys);
    });
  });

  describe('Iteration lifecycle', function () {
    it('should stop an active iterator without waiting for new samples', async function () {
      const sysmontap = dvt.sysmontap;
      const iterator = sysmontap.messages();

      // Begin consumption so the iterator blocks in receivePlist().
      const nextPromise = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await sysmontap.stop();

      const terminal = await Promise.race([
        (async () => {
          // Drain whatever is buffered until the generator completes.
          let result = await nextPromise;
          while (!result.done) {
            result = await iterator.next();
          }
          return result;
        })(),
        new Promise<never>((resolve, reject) =>
          setTimeout(() => reject(new Error('sysmontap iterator did not stop')), 5000),
        ),
      ]);

      assert.strictEqual(terminal.done, true);
    });

    it('should handle break in iteration properly', async function () {
      const sysmontap = dvt.sysmontap;

      let iterationCount = 0;
      for await (const sample of sysmontap.messages()) {
        assert.ok(typeof sample === 'object' && sample !== null && !Array.isArray(sample));
        iterationCount++;
        if (iterationCount === 2) {
          break;
        }
      }

      assert.strictEqual(iterationCount, 2);
    });

    it('should treat a second start() while sampling as a no-op', async function () {
      const sysmontap = dvt.sysmontap;

      await sysmontap.start();
      // A redundant start() must not re-issue setConfig/start or throw.
      await sysmontap.start();

      // Sampling is still healthy: a snapshot can be read.
      let received = false;
      for await (const sample of sysmontap.messages()) {
        assert.ok(typeof sample === 'object' && sample !== null && !Array.isArray(sample));
        received = true;
        break;
      }
      assert.strictEqual(received, true);
    });

    it('should end the stream without throwing when the DVT connection is closed', async function () {
      const sysmontap = dvt.sysmontap;
      const iterator = sysmontap.messages();

      // Begin consumption so the iterator blocks in receivePlist().
      const nextPromise = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Close the underlying connection from under the active stream.
      await dvt.dvtService.close();

      const terminal = await Promise.race([
        (async () => {
          let result = await nextPromise;
          while (!result.done) {
            result = await iterator.next();
          }
          return result;
        })(),
        new Promise<never>((resolve, reject) =>
          setTimeout(() => reject(new Error('sysmontap iterator did not end on connection close')), 5000),
        ),
      ]);

      assert.strictEqual(terminal.done, true);
    });
  });
});
