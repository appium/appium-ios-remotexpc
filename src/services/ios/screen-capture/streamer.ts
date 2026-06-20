import { performance } from 'node:perf_hooks';

export const MAX_SCREEN_CAPTURE_FPS = 240;
const ACTUAL_FPS_WINDOW_MS = 1000;

export interface CaptureScreenshotOptions {
  /** DVT screenshot captures the primary display; this is returned as metadata only. */
  displayUniqueId?: string | null;
}

export interface CaptureScreenshotResult {
  image: Buffer;
  displayUniqueID?: string | null;
  imageFormat?: string;
  [key: string]: unknown;
}

export interface ScreenCaptureStreamerOptions extends CaptureScreenshotOptions {
  /** Target frames per second. Capture time is included in the frame budget. */
  fps: number;
}

export class ScreenCaptureStreamer {
  private frameRate: number;
  private stopped = false;
  private paused = false;
  private readonly captureOptions: CaptureScreenshotOptions;
  private readonly abortController = new AbortController();
  private readonly frameTimestamps: number[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    options: ScreenCaptureStreamerOptions,
    private readonly captureScreenshot: (
      options: CaptureScreenshotOptions,
    ) => Promise<CaptureScreenshotResult>,
    private readonly onStop: (streamer: ScreenCaptureStreamer) => void,
  ) {
    validateFps(options.fps);
    this.frameRate = options.fps;
    this.captureOptions = {
      displayUniqueId: options.displayUniqueId,
    };
  }

  get fps(): number {
    return this.frameRate;
  }

  get actualFps(): number {
    this.pruneFrameTimestamps(performance.now());
    if (this.frameTimestamps.length < 2) {
      return 0;
    }

    const firstFrameAt = this.frameTimestamps[0];
    const lastFrameAt = this.frameTimestamps[this.frameTimestamps.length - 1];
    const elapsedMs = lastFrameAt - firstFrameAt;
    return elapsedMs > 0
      ? ((this.frameTimestamps.length - 1) * 1000) / elapsedMs
      : 0;
  }

  set fps(fps: number) {
    validateFps(fps);
    this.frameRate = fps;
    this.wakeWaiters();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  pause(): void {
    if (this.stopped) {
      return;
    }
    this.paused = true;
  }

  resume(): void {
    if (this.stopped) {
      return;
    }
    this.paused = false;
    this.wakeWaiters();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController.abort();
    this.wakeWaiters();
    this.onStop(this);
  }

  /**
   * Yield screenshots until stopped. Breaking out of iteration stops this streamer.
   */
  async *frames(): AsyncGenerator<CaptureScreenshotResult, void, unknown> {
    try {
      while (!this.stopped) {
        await this.waitWhilePaused();
        if (this.stopped) {
          break;
        }

        const startedAt = performance.now();
        // DVT screenshots are request/response captures, not a native stream.
        // Profiling on device showed almost all frame time waiting for the
        // DVT response (~145ms), while send/decode overhead was sub-millisecond.
        const frame = await this.captureScreenshot(this.captureOptions);
        this.recordFrame(performance.now());
        yield frame;

        await this.waitForNextFrame(startedAt);
      }
    } finally {
      this.stop();
    }
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) {
      await this.waitForWake();
    }
  }

  private async waitForNextFrame(frameStartedAt: number): Promise<void> {
    while (!this.stopped && !this.paused) {
      const nextFrameAt = frameStartedAt + 1000 / this.frameRate;
      const delayMs = nextFrameAt - performance.now();
      if (delayMs <= 0) {
        return;
      }
      await this.waitForWake(delayMs);
    }
  }

  private waitForWake(timeoutMs?: number): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      };

      this.waiters.push(done);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(done, timeoutMs);
      }
      if (this.abortController.signal.aborted) {
        done();
      }
    });
  }

  private wakeWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private recordFrame(timestamp: number): void {
    this.frameTimestamps.push(timestamp);
    this.pruneFrameTimestamps(timestamp);
  }

  private pruneFrameTimestamps(now: number): void {
    const cutoff = now - ACTUAL_FPS_WINDOW_MS;
    while (
      this.frameTimestamps.length > 0 &&
      this.frameTimestamps[0] < cutoff
    ) {
      this.frameTimestamps.shift();
    }
  }
}

function validateFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_SCREEN_CAPTURE_FPS) {
    throw new Error(
      `fps must be a positive finite number not greater than ${MAX_SCREEN_CAPTURE_FPS}. Got ${fps}`,
    );
  }
}
