import type { TunnelRegistryEntry } from '../types.js';

interface Waiter {
  resolve: (entry: TunnelRegistryEntry) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * In-process readiness coordination for long-poll GET /tunnels/:udid?waitMs=.
 * Lives in the tunnel-creation / registry server process only.
 */
export class TunnelReadinessCoordinator {
  private waitersByUdid = new Map<string, Waiter[]>();

  /** Clear readiness; new waiters block until the next {@link resolveReady}. */
  markPending(udid: string): void {
    const waiters = this.waitersByUdid.get(udid);
    if (!waiters?.length) {
      return;
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Tunnel ${udid} is not ready`));
    }
    this.waitersByUdid.delete(udid);
  }

  /**
   * Wait until {@link resolveReady} for `udid`, or reject after `waitMs`.
   */
  waitForReady(udid: string, waitMs: number): Promise<TunnelRegistryEntry> {
    return new Promise<TunnelRegistryEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(udid, waiter);
        reject(new Error('NOT_READY'));
      }, waitMs);

      const waiter: Waiter = {
        resolve: (entry) => {
          clearTimeout(timer);
          resolve(entry);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };

      const list = this.waitersByUdid.get(udid) ?? [];
      list.push(waiter);
      this.waitersByUdid.set(udid, list);
    });
  }

  /** Unblock all waiters for `udid` with the published registry entry. */
  resolveReady(udid: string, entry: TunnelRegistryEntry): void {
    const waiters = this.waitersByUdid.get(udid);
    if (!waiters?.length) {
      return;
    }
    this.waitersByUdid.delete(udid);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(entry);
    }
  }

  private removeWaiter(udid: string, target: Waiter): void {
    const waiters = this.waitersByUdid.get(udid);
    if (!waiters) {
      return;
    }
    const next = waiters.filter((w) => w !== target);
    if (next.length) {
      this.waitersByUdid.set(udid, next);
    } else {
      this.waitersByUdid.delete(udid);
    }
  }
}
