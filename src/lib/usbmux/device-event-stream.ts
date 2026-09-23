import type {Device} from './index.js';

/**
 * Emitted by {@link Usbmux.listen} when a device is plugged in (or an already-connected
 * device is reported for the first time after the Listen request is acknowledged).
 */
export interface UsbmuxAttachEvent {
  type: 'attach';
  device: Device;
}

/**
 * Emitted by {@link Usbmux.listen} when a device is unplugged. usbmuxd's `Detached`
 * message only carries the numeric `DeviceID`, not the device's properties.
 */
export interface UsbmuxDetachEvent {
  type: 'detach';
  deviceId: number;
}

export type UsbmuxDeviceEvent = UsbmuxAttachEvent | UsbmuxDetachEvent;

/**
 * Called exactly once when a {@link UsbmuxDeviceEventStream} stops, so its owner can unregister it.
 */
export type UsbmuxDeviceEventStreamStopHandler = (stream: UsbmuxDeviceEventStream) => void;

/**
 * Async-iterable queue of usbmuxd device notifications for a single `Listen` subscription.
 *
 * The owning {@link Usbmux} instance feeds it via {@link push} / {@link fail}; consumers
 * drain it with `for await`. Events that arrive while no consumer is waiting are buffered.
 * Once the stream stops (via {@link stop}, {@link fail} or the abort signal), already-buffered
 * events are still delivered first; only then does iteration end, or reject after `fail()`.
 * `return()` (e.g. `break` in `for await`) ends iteration immediately and discards the buffer.
 */
export class UsbmuxDeviceEventStream implements AsyncIterableIterator<UsbmuxDeviceEvent> {
  private readonly queue: UsbmuxDeviceEvent[] = [];
  private readonly waiters: (() => void)[] = [];
  private isStopped = false;
  private failure: Error | null = null;
  private readonly onAbort = () => this.stop();

  /**
   * @param onStop - Invoked exactly once when the stream stops
   * @param signal - When aborted, stops the stream
   */
  constructor(
    private readonly onStop: UsbmuxDeviceEventStreamStopHandler,
    private readonly signal?: AbortSignal,
  ) {
    if (signal?.aborted) {
      this.isStopped = true;
    } else {
      signal?.addEventListener('abort', this.onAbort);
    }
  }

  /**
   * Whether the stream has stopped accepting events.
   */
  get stopped(): boolean {
    return this.isStopped;
  }

  /**
   * Enqueues an event for the consumer. Ignored once the stream has stopped.
   * @param event - Device event to deliver
   */
  push(event: UsbmuxDeviceEvent): void {
    if (this.isStopped) {
      return;
    }
    this.queue.push(event);
    this.notifyWaiters();
  }

  /**
   * Stops the stream and makes the next `next()` call reject with `err`.
   * @param err - Error to surface to the consumer
   */
  fail(err: Error): void {
    if (this.isStopped) {
      return;
    }
    this.failure = err;
    this.stop();
  }

  /**
   * Stops the stream. Idempotent.
   */
  stop(): void {
    if (this.isStopped) {
      return;
    }
    this.isStopped = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.onStop(this);
    this.notifyWaiters();
  }

  /**
   * Resolves with the next buffered event, waiting for one if necessary. Concurrent calls are
   * each resolved in turn.
   * @returns The next event, or `done` once the stream has stopped and drained
   * @throws The error passed to {@link fail}, once all buffered events have been delivered
   */
  async next(): Promise<IteratorResult<UsbmuxDeviceEvent>> {
    while (this.queue.length === 0 && !this.isStopped) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    const event = this.queue.shift();
    if (event) {
      return {done: false, value: event};
    }
    if (this.failure) {
      const err = this.failure;
      this.failure = null;
      throw err;
    }
    return {done: true, value: undefined};
  }

  /**
   * Stops the stream and discards buffered events. Called by `break`/`return` in `for await`.
   * @returns A `done` iterator result
   */
  async return(): Promise<IteratorResult<UsbmuxDeviceEvent>> {
    this.stop();
    this.queue.length = 0;
    this.failure = null;
    return {done: true, value: undefined};
  }

  /**
   * @returns This stream, which is its own iterator
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<UsbmuxDeviceEvent> {
    return this;
  }

  private notifyWaiters(): void {
    for (const wake of this.waiters.splice(0)) {
      wake();
    }
  }
}
