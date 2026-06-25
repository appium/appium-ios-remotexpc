import { getLogger } from '../../../../lib/logger.js';
import { MessageAux } from '../dtx-message.js';
import { BaseInstrument } from './base-instrument.js';

const log = getLogger('EnergyMonitor');

export interface EnergyMetrics {
  'energy.overhead'?: number;
  'energy.cost'?: number;
  'energy.networking.overhead'?: number;
  'energy.networking.cost'?: number;
  'energy.appstate.cost'?: number;
  'energy.appstate.overhead'?: number;
  'energy.location.overhead'?: number;
  'energy.location.cost'?: number;
  'energy.thermalstate.cost'?: number;
  'energy.cpu.cost'?: number;
  'energy.cpu.overhead'?: number;
  'energy.gpu.cost'?: number;
  'energy.gpu.overhead'?: number;
  'energy.inducedthermalstate.cost'?: number;
  [key: string]: number | undefined;
}

/** Maps PID (as string key) to its energy metrics snapshot */
export type EnergyMonitorSample = Record<string, EnergyMetrics>;

/**
 * Energy monitor service using Apple's Xcode energy gauge data provider.
 *
 * @example
 * ```typescript
 * const energy = new EnergyMonitor(dvt);
 * for await (const sample of energy.monitor([1234])) {
 *   console.log(sample);
 * }
 * ```
 */
export class EnergyMonitor extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.xcode.debug-gauge-data-providers.Energy';

  async startSampling(pids: number[]): Promise<void> {
    await this.initialize();
    const channel = this.requireChannel();
    await channel.call('startSamplingForPIDs_')(
      new MessageAux().appendObj(pids),
      false,
    );
  }

  async stopSampling(pids: number[]): Promise<void> {
    const channel = this.requireChannel();
    await channel.call('stopSamplingForPIDs_')(
      new MessageAux().appendObj(pids),
      false,
    );
  }

  async sample(pids: number[]): Promise<EnergyMonitorSample> {
    const channel = this.requireChannel();
    const args = new MessageAux().appendObj({}).appendObj(pids);
    await channel.call('sampleAttributes_forPIDs_')(args);
    return await channel.receivePlist();
  }

  /**
   * Continuously samples energy metrics for the given PIDs.
   * Stops monitoring on generator return or throw.
   */
  async *monitor(
    pids: number[],
  ): AsyncGenerator<EnergyMonitorSample, void, undefined> {
    log.debug('Energy monitoring started');
    // initialize() before stopSampling so requireChannel() doesn't throw on first use
    await this.initialize();
    // Stop first in case a previous session is still active
    await this.stopSampling(pids);
    await this.startSampling(pids);

    try {
      while (true) {
        yield await this.sample(pids);
      }
    } finally {
      log.debug('Energy monitoring stopped');
      await this.stopSampling(pids);
    }
  }
}
