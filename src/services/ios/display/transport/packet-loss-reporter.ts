import type {getLogger} from '../../../../lib/logger.js';

/** The logger type `getLogger` hands out. */
type Logger = ReturnType<typeof getLogger>;

/** Default gap between summary lines. */
const DEFAULT_INTERVAL_MS = 5000;

/** Options for {@link PacketLossReporter}. */
export interface PacketLossReporterOptions {
  /** Minimum gap between log lines, in milliseconds. Defaults to 5000. */
  intervalMs?: number;
}

/**
 * Rate-limited reporting of RTP sequence gaps.
 *
 * Logging every gap is unusable in the case that matters: a degrading link
 * loses packets in bursts, so the moment the log becomes interesting is the
 * moment it floods — at 30 fps a video frame spans dozens of packets, and a few
 * seconds of a bad link can produce thousands of lines that push the
 * surrounding context out of the buffer.
 *
 * So gaps are accumulated and summarised at most once per interval, and each
 * line carries the running totals. The first gap is always reported, so the
 * onset of loss is never delayed.
 *
 * This is diagnostics only — the exact counters live in each capture's `stats`
 * and are always complete.
 */
export class PacketLossReporter {
  private readonly log: Logger;
  private readonly label: string;
  private readonly intervalMs: number;

  private pendingGaps = 0;
  private pendingPackets = 0;
  private totalGaps = 0;
  private totalPackets = 0;
  private lastReportAt: number | undefined;

  /**
   * @param log Where to write the summaries.
   * @param label Stream name used to prefix each line, e.g. `audio`.
   * @param options Reporting interval.
   */
  constructor(log: Logger, label: string, options: PacketLossReporterOptions = {}) {
    this.log = log;
    this.label = label;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * Records one sequence gap.
   *
   * @param missingPackets How many packets the gap covers.
   * @param sequence The sequence number that arrived after the gap.
   */
  record(missingPackets: number, sequence: number): void {
    this.pendingGaps += 1;
    this.pendingPackets += missingPackets;
    this.totalGaps += 1;
    this.totalPackets += missingPackets;

    const now = performance.now();
    if (this.lastReportAt !== undefined && now - this.lastReportAt < this.intervalMs) {
      return;
    }
    this.lastReportAt = now;
    this.emit(sequence);
  }

  /**
   * Reports anything accumulated since the last summary.
   *
   * Called at teardown so a burst of loss in the final interval is not dropped
   * from the log entirely.
   */
  flush(): void {
    if (this.pendingGaps === 0) {
      return;
    }
    this.emit();
  }

  private emit(sequence?: number): void {
    const where = sequence === undefined ? '' : ` before sequence ${sequence}`;
    const totals =
      this.pendingGaps === this.totalGaps ? '' : ` (${this.totalPackets} packet(s) in ${this.totalGaps} gap(s) so far)`;
    this.log.debug(
      `${this.label} RTP gap: ${this.pendingPackets} packet(s) lost across ` +
        `${this.pendingGaps} gap(s)${where}${totals}`,
    );
    this.pendingGaps = 0;
    this.pendingPackets = 0;
  }
}
