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
 * Async-iterable queue of usbmuxd device notifications for a single `Listen` subscription.
 *
 * The owning {@link Usbmux} instance feeds it via {@link push} / {@link fail}; consumers
 * drain it with `for await`. Events that arrive while no consumer is waiting are buffered.
 * Iteration ends once {@link stop} is called (directly, via `return()`/`break`, or through
 * the abort signal), after any already-buffered events have been delivered.
 */
export class UsbmuxDeviceEventStream implements AsyncIterableIterator<UsbmuxDeviceEvent> {
  private readonly _queue: UsbmuxDeviceEvent[] = [];
  private _wake: (() => void) | null = null;
  private _stopped = false;
  private _failure: Error | null = null;
  private readonly _signal?: AbortSignal;
  private readonly _onStop: (stream: UsbmuxDeviceEventStream) => void;
  private readonly _onAbort = () => this.stop();

  /**
   * @param onStop - Invoked exactly once when the stream stops, so the owner can unregister it
   * @param signal - When aborted, stops the stream
   */
  constructor(onStop: (stream: UsbmuxDeviceEventStream) => void, signal?: AbortSignal) {
    this._onStop = onStop;
    this._signal = signal;
    if (signal?.aborted) {
      this._stopped = true;
    } else {
      signal?.addEventListener('abort', this._onAbort);
    }
  }

  get stopped(): boolean {
    return this._stopped;
  }

  /**
   * Enqueues an event for the consumer. Ignored once the stream has stopped.
   */
  push(event: UsbmuxDeviceEvent): void {
    if (this._stopped) {
      return;
    }
    this._queue.push(event);
    this._notifyWaiter();
  }

  /**
   * Stops the stream and makes the next `next()` call reject with `err`.
   */
  fail(err: Error): void {
    if (this._stopped) {
      return;
    }
    this._failure = err;
    this.stop();
  }

  /**
   * Stops the stream. Idempotent.
   */
  stop(): void {
    if (this._stopped) {
      return;
    }
    this._stopped = true;
    this._signal?.removeEventListener('abort', this._onAbort);
    this._onStop(this);
    this._notifyWaiter();
  }

  async next(): Promise<IteratorResult<UsbmuxDeviceEvent>> {
    while (this._queue.length === 0 && !this._stopped) {
      await new Promise<void>((resolve) => {
        this._wake = resolve;
      });
    }
    if (this._failure) {
      const err = this._failure;
      this._failure = null;
      throw err;
    }
    const event = this._queue.shift();
    return event ? {done: false, value: event} : {done: true, value: undefined};
  }

  async return(): Promise<IteratorResult<UsbmuxDeviceEvent>> {
    this.stop();
    this._queue.length = 0;
    return {done: true, value: undefined};
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<UsbmuxDeviceEvent> {
    return this;
  }

  private _notifyWaiter(): void {
    const wake = this._wake;
    this._wake = null;
    wake?.();
  }
}
