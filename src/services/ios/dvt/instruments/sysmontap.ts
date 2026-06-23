import { getLogger } from '../../../../lib/logger.js';
import type {
  SysmonProcessInfo,
  SysmonSample,
  SysmonSystemInfo,
  SysmontapOptions,
} from '../../../../lib/types.js';
import { MessageAux } from '../dtx-message.js';
import { BaseInstrument } from './base-instrument.js';
import { DeviceInfo } from './device-info.js';

const log = getLogger('Sysmontap');

/**
 * Sysmontap provides real-time sampling of per-process and system resource
 * usage (CPU, memory, disk, etc.) on iOS devices.
 *
 * The instrument is configured with a set of process and system attribute
 * names (queried from the device via {@link DeviceInfo} unless overridden) and
 * a sampling interval. Once started, the device streams samples; each sample
 * carries the raw value tuples that are mapped back to the attribute names.
 *
 * @example
 * ```typescript
 * const { sysmontap, dvtService } = await Services.startDVTService(udid);
 * try {
 *   await sysmontap.configure({ intervalMs: 1000 });
 *   for await (const processes of sysmontap.iterProcesses()) {
 *     console.log(processes.length, 'processes');
 *     break;
 *   }
 * } finally {
 *   await sysmontap.stop();
 *   await dvtService.close();
 * }
 * ```
 */
export class Sysmontap extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.sysmontap';

  /** Default sampling interval in milliseconds. */
  static readonly DEFAULT_INTERVAL_MS = 500;

  /** Minimum permitted sampling interval in milliseconds. */
  static readonly MINIMUM_INTERVAL_MS = 1;

  private processAttributes: string[] = [];
  private systemAttributes: string[] = [];
  private builtConfig: Record<string, unknown> | null = null;
  private started = false;
  private stopRequested = false;
  private receiveAbortController: AbortController | null = null;

  /**
   * The process attribute names currently in effect. Empty until
   * {@link configure} (or {@link start}) has run.
   */
  getProcessAttributes(): string[] {
    return [...this.processAttributes];
  }

  /**
   * The system attribute names currently in effect. Empty until
   * {@link configure} (or {@link start}) has run.
   */
  getSystemAttributes(): string[] {
    return [...this.systemAttributes];
  }

  /**
   * Resolve the sampling attributes (querying the device when not overridden)
   * and build the sampling configuration. This does not start sampling; the
   * configuration is (re)applied to the device by {@link start}. Safe to call
   * multiple times; the latest configuration wins.
   * @param options Optional sampling configuration
   */
  async configure(options: SysmontapOptions = {}): Promise<void> {
    if (options.processAttributes && options.systemAttributes) {
      this.processAttributes = options.processAttributes;
      this.systemAttributes = options.systemAttributes;
    } else {
      const deviceInfo = new DeviceInfo(this.dvt);
      this.processAttributes =
        options.processAttributes ??
        (await deviceInfo.sysmonProcessAttributes());
      this.systemAttributes =
        options.systemAttributes ?? (await deviceInfo.sysmonSystemAttributes());
    }

    const intervalMs = Math.max(
      options.intervalMs ?? Sysmontap.DEFAULT_INTERVAL_MS,
      Sysmontap.MINIMUM_INTERVAL_MS,
    );

    this.builtConfig = {
      ur: Sysmontap.MINIMUM_INTERVAL_MS, // Output frequency (ms)
      bm: 0,
      procAttrs: this.processAttributes,
      sysAttrs: this.systemAttributes,
      cpuUsage: true,
      physFootprint: true, // Include physical memory footprint
      sampleInterval: intervalMs * 1_000_000, // Sample interval in nanoseconds
    };

    log.debug(
      `sysmontap configured: interval=${intervalMs}ms, ` +
        `${this.processAttributes.length} process attrs, ` +
        `${this.systemAttributes.length} system attrs`,
    );
  }

  /**
   * Begin sampling. Resolves the configuration first (with defaults) when
   * {@link configure} has not been called.
   *
   * A sysmontap instance supports a single sampling session per DVT
   * connection: once a stream has been {@link stop}ped, the device does not
   * resume it on the same connection. To sample again, start a new DVT
   * connection (e.g. via `Services.startDVTService`).
   */
  async start(): Promise<void> {
    if (!this.builtConfig) {
      await this.configure();
    }
    await this.initialize();
    const channel = this.requireChannel();

    // setConfig must precede start so the device knows which attributes to
    // sample.
    const args = new MessageAux().appendObj(this.builtConfig);
    await channel.call('setConfig_')(args, false);

    this.stopRequested = false;
    await channel.call('start')(undefined, false);
    this.started = true;
    log.debug('sysmontap sampling started');
  }

  /**
   * Stop sampling and unblock any in-flight iterator.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.receiveAbortController?.abort();
    if (this.channel && this.started) {
      try {
        await this.requireChannel().call('stop')(undefined, false);
      } catch (error) {
        log.debug('Error sending stop to sysmontap:', error);
      }
    }
    this.started = false;
    log.debug('sysmontap sampling stopped');
  }

  /**
   * Async iterator that yields raw sysmontap samples as they arrive. The
   * device interleaves two kinds of samples: system samples (with `System`,
   * `SystemAttributes`, CPU usage) and process samples (with `Processes`).
   * Internal control/heartbeat frames are filtered out.
   *
   * Sampling starts automatically on first iteration and stops when iteration
   * terminates (via break, return, or error).
   */
  async *messages(): AsyncGenerator<SysmonSample, void, unknown> {
    await this.start();

    try {
      while (!this.stopRequested) {
        const channel = this.requireChannel();
        const receiveAbortController = new AbortController();
        this.receiveAbortController = receiveAbortController;

        let plist: unknown;
        try {
          plist = await channel.receivePlist(receiveAbortController.signal);
        } catch (err) {
          if (this.stopRequested && this.isAbortError(err)) {
            break;
          }
          throw err;
        } finally {
          if (this.receiveAbortController === receiveAbortController) {
            this.receiveAbortController = null;
          }
        }

        // Data samples arrive as an array of one or more sample dictionaries.
        // Other payloads (e.g. `{ DTTapMessagePlist: { k: 8, heart } }` control
        // and heartbeat frames, or a null parse failure) are not samples and
        // are skipped.
        if (!Array.isArray(plist)) {
          continue;
        }

        for (const row of plist) {
          if (row && typeof row === 'object') {
            yield row as SysmonSample;
          }
        }
      }
    } finally {
      await this.stop();
    }
  }

  /**
   * Async iterator that yields labelled per-process snapshots. Each yielded
   * value is the list of processes contained in a single sample, with the raw
   * per-process value tuples mapped to objects keyed by the configured process
   * attribute names.
   *
   * Note: the first emitted snapshot typically contains uninitialised
   * `cpuUsage` values and is commonly skipped by consumers.
   */
  async *iterProcesses(): AsyncGenerator<SysmonProcessInfo[], void, unknown> {
    for await (const sample of this.messages()) {
      const processes = sample.Processes;
      if (!processes || typeof processes !== 'object') {
        continue;
      }

      const entries: SysmonProcessInfo[] = [];
      for (const values of Object.values(processes)) {
        if (Array.isArray(values)) {
          entries.push(this.zipAttributes(this.processAttributes, values));
        }
      }
      yield entries;
    }
  }

  /**
   * Map a raw sample's `System` tuple to a labelled object using the configured
   * system attribute names.
   * @param sample A sample yielded by {@link messages}
   * @returns The labelled system info, or `null` when the sample has no system data
   */
  parseSystem(sample: SysmonSample): SysmonSystemInfo | null {
    const system = sample.System;
    if (!Array.isArray(system)) {
      return null;
    }
    return this.zipAttributes(this.systemAttributes, system);
  }

  /**
   * Zip an ordered list of attribute names with a raw value tuple.
   */
  private zipAttributes(
    attributes: string[],
    values: unknown[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (let i = 0; i < attributes.length; i++) {
      result[attributes[i]] = values[i];
    }
    return result;
  }

  private isAbortError(err: unknown): boolean {
    return (
      err instanceof DOMException ||
      (err instanceof Error && err.name === 'AbortError')
    );
  }
}
