import { logger } from '@appium/support';
import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import type { DVTInstruments } from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import { requireDeviceUdid } from '../helpers/device.js';

const log = logger.getLogger('EnergyMonitor.test');

describe('EnergyMonitor Service', { timeout: 60000 }, function () {
  let dvt: DVTInstruments | null = null;
  let calculatorPid: number | null = null;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();

    dvt = await Services.startDVTService(udid);
    calculatorPid = await dvt.processControl.launch({
      bundleId: 'com.apple.calculator',
      killExisting: true,
    });
    log.debug(`Launched Calculator with PID: ${calculatorPid}`);
  });

  after(async function () {
    if (dvt && calculatorPid) {
      try {
        await dvt.processControl.kill(calculatorPid);
      } catch {}
    }
    if (dvt) {
      try {
        await dvt.dvtService.close();
      } catch {}
    }
  });

  it('should have energyMonitor service', function () {
    expect(dvt).to.not.be.null;
    expect(dvt!.energyMonitor).to.not.be.null;
  });

  it('should start and stop sampling without error', async function () {
    const pids = [calculatorPid!];
    await dvt!.energyMonitor.startSampling(pids);
    await dvt!.energyMonitor.stopSampling(pids);
  });

  it('should return a sample keyed by PID', async function () {
    const pids = [calculatorPid!];
    await dvt!.energyMonitor.startSampling(pids);

    try {
      const sample = await dvt!.energyMonitor.sample(pids);
      log.debug('Energy sample:', JSON.stringify(sample, null, 2));

      expect(sample).to.be.an('object');
      expect(sample).to.have.property(String(calculatorPid));
      expect(sample[String(calculatorPid)]).to.be.an('object');
    } finally {
      await dvt!.energyMonitor.stopSampling(pids);
    }
  });

  it('should include known energy metric keys in sample', async function () {
    const pids = [calculatorPid!];
    await dvt!.energyMonitor.startSampling(pids);

    try {
      const sample = await dvt!.energyMonitor.sample(pids);
      const metrics = sample[String(calculatorPid)];

      expect(metrics).to.be.an('object');
      expect(metrics).to.have.property('energy.cost');
      expect(metrics).to.have.property('energy.overhead');
      expect(metrics['energy.cost']).to.be.a('number');
      expect(metrics['energy.overhead']).to.be.a('number');
    } finally {
      await dvt!.energyMonitor.stopSampling(pids);
    }
  });

  it('should yield consecutive samples from monitor generator', async function () {
    const pids = [calculatorPid!];
    const samples: Record<string, Record<string, number>>[] = [];

    const gen = dvt!.energyMonitor.monitor(pids);
    try {
      for await (const sample of gen) {
        samples.push(sample);
        if (samples.length >= 3) {
          break;
        }
      }
    } finally {
      await gen.return(undefined);
    }

    expect(samples).to.have.length(3);
    for (const sample of samples) {
      expect(sample).to.have.property(String(calculatorPid));
    }
  });

  it('should stop monitoring cleanly when generator is returned early', async function () {
    const pids = [calculatorPid!];
    const gen = dvt!.energyMonitor.monitor(pids);

    const { value: firstSample } = await gen.next();
    await gen.return(undefined);

    expect(firstSample).to.be.an('object');
    expect(firstSample).to.have.property(String(calculatorPid));
  });
});
