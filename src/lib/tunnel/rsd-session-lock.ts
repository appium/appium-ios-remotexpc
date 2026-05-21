import AsyncLock from 'async-lock';

const rsdSessionLock = new AsyncLock();

/** Lock key for one tunnel RSD endpoint (`host:rsdPort`). */
export function rsdSessionLockKey(address: string, rsdPort: number): string {
  return `${address}:${rsdPort}`;
}

/** True while a discovery session holds the per-tunnel RSD lock. */
export function isRsdDiscoveryBusy(host: string, rsdPort: number): boolean {
  return rsdSessionLock.isBusy(rsdSessionLockKey(host, rsdPort));
}

/**
 * Run `fn` while holding the per-tunnel RSD discovery lock (connect → discover → close).
 */
export async function runSerializedRsdSession<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await rsdSessionLock.acquire(lockKey, fn);
}
