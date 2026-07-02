import {type TestContext, afterEach, beforeEach, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

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

      expect(attributes).to.be.an('array');
      expect(attributes.length).to.be.greaterThan(0);
      attributes.forEach((attr) => expect(attr).to.be.a('string'));
      // 'pid' is always part of the per-process attribute set.
      expect(attributes).to.include('pid');
      log.info(`process attributes (${attributes.length}):`, attributes);
    });

    it('should fetch sysmon system attributes', async function () {
      const attributes = await dvt.deviceInfo.sysmonSystemAttributes();

      expect(attributes).to.be.an('array');
      expect(attributes.length).to.be.greaterThan(0);
      attributes.forEach((attr) => expect(attr).to.be.a('string'));
      log.info(`system attributes (${attributes.length}):`, attributes);
    });
  });

  describe('Configuration', function () {
    it('should expose discovered attributes after configuring', async function () {
      const sysmontap = dvt.sysmontap;
      await sysmontap.configure({intervalMs: 1000});

      const processAttributes = sysmontap.getProcessAttributes();
      const systemAttributes = sysmontap.getSystemAttributes();

      expect(processAttributes).to.be.an('array').with.length.greaterThan(0);
      expect(systemAttributes).to.be.an('array').with.length.greaterThan(0);
      expect(processAttributes).to.include('pid');
    });
  });

  describe('Process sampling', function () {
    it('should stream labelled process snapshots through iterProcesses()', async function () {
      const sysmontap = dvt.sysmontap;

      const snapshots = await collectProcessSnapshots(sysmontap, 2);
      expect(snapshots).to.have.length.greaterThan(0);

      const processAttributes = sysmontap.getProcessAttributes();
      const populated = snapshots.find((snapshot) => snapshot.length > 0);
      expect(populated, 'expected at least one populated process snapshot').to.exist;

      const processes = populated!;
      expect(processes.length).to.be.greaterThan(0);

      const sample = processes[0];
      expect(sample).to.be.an('object');
      // Every labelled record is keyed by the discovered attribute names and
      // exposes one value per attribute.
      const recordKeys = Object.keys(sample);
      expect(recordKeys).to.have.lengthOf(processAttributes.length);
      recordKeys.forEach((key) => expect(processAttributes).to.include(key));
      expect(sample).to.have.property('pid');
      expect(sample.pid).to.satisfy((v: unknown) => typeof v === 'number' || typeof v === 'bigint');

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
      expect(allProcesses.length).to.be.greaterThan(0);

      // Correctness check on the positional attribute mapping: pid 1 must be
      // launchd. This only holds if the DeviceInfo attribute order matches the
      // order of the streamed per-process value tuples.
      const launchd = allProcesses.find((proc) => proc.pid === 1);
      expect(launchd, 'expected pid 1 in a snapshot').to.exist;
      expect(launchd!.name).to.equal('launchd');

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

      expect(samples).to.have.lengthOf(maxSamples);
      samples.forEach((sample) => expect(sample).to.be.an('object'));

      // Control/heartbeat frames are filtered out, so every yielded sample is
      // either a system sample or a process sample.
      samples.forEach((sample) =>
        expect(
          sample.Processes !== undefined || sample.System !== undefined,
          `sample keys: ${Object.keys(sample).join(', ')}`,
        ).to.equal(true),
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

      expect(parsedSystem, 'expected to observe a system sample').to.exist;
      const systemAttributes = sysmontap.getSystemAttributes();
      const keys = Object.keys(parsedSystem!);
      expect(keys.length).to.equal(systemAttributes.length);
      keys.forEach((key) => expect(systemAttributes).to.include(key));
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

      expect(terminal.done).to.equal(true);
    });

    it('should handle break in iteration properly', async function () {
      const sysmontap = dvt.sysmontap;

      let iterationCount = 0;
      for await (const sample of sysmontap.messages()) {
        expect(sample).to.be.an('object');
        iterationCount++;
        if (iterationCount === 2) {
          break;
        }
      }

      expect(iterationCount).to.equal(2);
    });

    it('should treat a second start() while sampling as a no-op', async function () {
      const sysmontap = dvt.sysmontap;

      await sysmontap.start();
      // A redundant start() must not re-issue setConfig/start or throw.
      await sysmontap.start();

      // Sampling is still healthy: a snapshot can be read.
      let received = false;
      for await (const sample of sysmontap.messages()) {
        expect(sample).to.be.an('object');
        received = true;
        break;
      }
      expect(received).to.equal(true);
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

      expect(terminal.done).to.equal(true);
    });
  });
});
