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

  private sampling = false;
  private stopRequested = false;
  private receiveAbortController: AbortController | null = null;

  /**
   * Start energy sampling for the given PIDs.
   * Idempotent: a second call while already sampling is a no-op.
   */
  async startSampling(pids: number[]): Promise<void> {
    if (this.sampling) {
      log.debug('energy monitor already sampling; startSampling() is a no-op');
      return;
    }
    await this.initialize();
    const channel = this.requireChannel();
    this.stopRequested = false;
    await channel.call('startSamplingForPIDs_')(
      new MessageAux().appendObj(pids),
      false,
    );
    this.sampling = true;
  }

  /**
   * Stop energy sampling for the given PIDs.
   * Safe to call when not sampling or before initialization.
   */
  async stopSampling(pids: number[]): Promise<void> {
    this.stopRequested = true;
    this.receiveAbortController?.abort();

    if (!this.sampling) {
      return;
    }
    this.sampling = false;

    if (this.channel) {
      try {
        await this.channel.call('stopSamplingForPIDs_')(
          new MessageAux().appendObj(pids),
          false,
        );
      } catch (error) {
        log.debug(
          'energy monitor stopSampling() could not notify the device:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Take a single energy snapshot for the given PIDs.
   *
   * {@link startSampling} must be called first. The call blocks until the
   * device replies, so calling this in a tight loop does not spin-loop the CPU.
   */
  async sample(pids: number[]): Promise<EnergyMonitorSample> {
    if (!this.sampling) {
      throw new Error('startSampling() must be called before sample()');
    }
    return await this.sampleOnce(pids);
  }

  /**
   * Continuously samples energy metrics for the given PIDs.
   * Stops when the generator is returned/thrown, when {@link stopSampling} is
   * called, or when the underlying DVT connection is closed.
   */
  async *monitor(
    pids: number[],
  ): AsyncGenerator<EnergyMonitorSample, void, undefined> {
    log.debug('Energy monitoring started');
    // Stop any prior session so monitor() always owns a clean lifecycle.
    await this.stopSampling(pids);
    await this.startSampling(pids);

    try {
      while (!this.stopRequested) {
        const abortController = new AbortController();
        this.receiveAbortController = abortController;

        let sample: EnergyMonitorSample | null = null;
        try {
          sample = await this.sampleOnce(pids, abortController.signal);
        } catch (err) {
          if (this.stopRequested || this.isAbortError(err)) {
            break;
          }
          log.debug(
            'energy monitor read error:',
            err instanceof Error ? err.message : err,
          );
          break;
        } finally {
          if (this.receiveAbortController === abortController) {
            this.receiveAbortController = null;
          }
        }

        if (sample !== null) {
          yield sample;
        }
      }
    } finally {
      log.debug('Energy monitoring stopped');
      await this.stopSampling(pids);
    }
  }

  private async sampleOnce(
    pids: number[],
    signal?: AbortSignal,
  ): Promise<EnergyMonitorSample> {
    const channel = this.requireChannel();
    await channel.call('sampleAttributes_forPIDs_')(
      new MessageAux().appendObj({}).appendObj(pids),
    );
    return await channel.receivePlist(signal);
  }

  private isAbortError(err: unknown): boolean {
    return (
      err instanceof DOMException ||
      (err instanceof Error && err.name === 'AbortError')
    );
  }
}
