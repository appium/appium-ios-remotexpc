import { type Socket, createConnection } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { getLogger } from '../logger.js';
import type { TunnelRegistry } from '../types.js';
import { isRsdDiscoveryBusy } from './rsd-session-lock.js';

const log = getLogger('TunnelRegistryLifecycle');

export interface TunnelRegistrySocketWatch {
  udid: string;
  /** CoreDeviceProxy (or equivalent) TLS socket; when it closes, the tunnel is gone. */
  socket: Socket | TLSSocket;
  /** Optional backup probe to `host:port` (typically tunnel RSD). */
  rsdProbe?: { host: string; port: number };
}

export interface WatchTunnelRegistryOptions {
  registry: TunnelRegistry;
  watches: TunnelRegistrySocketWatch[];
  /** Called after the UDID is removed from `registry.tunnels`. */
  onRemove?: (udid: string) => void | Promise<void>;
  /**
   * Called when a tunnel is considered dead (registry already updated).
   * Use to sync in-process state (e.g. TunnelManager.closeTunnelByAddress).
   */
  onTunnelDead?: (ctx: {
    udid: string;
    address: string;
  }) => void | Promise<void>;
  /**
   * Delay after each RSD probe finishes before the next one starts; `0` disables
   * (default: `5000`, 5 seconds). Probes never overlap.
   */
  rsdProbeIntervalMs?: number;
  /** Connect timeout per probe (default: `1000`, 1 second). */
  rsdProbeConnectTimeoutMs?: number;
  /**
   * Consecutive failed RSD probes required before removing a tunnel (default: `3`).
   * Avoids tearing down the registry when `remoted` is briefly busy with a discovery session.
   */
  rsdProbeFailureThreshold?: number;
}

interface RsdProbeLoopOptions {
  host: string;
  port: number;
  intervalMs: number;
  connectTimeoutMs: number;
  failureThreshold: number;
  shouldStop: () => boolean;
  onFinalize: (reason: string) => Promise<void>;
  registerTeardown: (cancel: () => void) => void;
}

/**
 * Removes a tunnel from the registry when its upstream socket dies, and optionally
 * polls RSD so half-open cases can still be detected.
 *
 * @returns `stop` — clears listeners and probes (e.g. for tests or shutdown).
 */
export function watchTunnelRegistrySockets(
  options: WatchTunnelRegistryOptions,
): { stop: () => void } {
  const {
    registry,
    watches,
    onRemove,
    onTunnelDead,
    rsdProbeIntervalMs = 5_000,
    rsdProbeConnectTimeoutMs = 1_000,
    rsdProbeFailureThreshold = 3,
  } = options;

  const stopped = { value: false };
  const teardownFns: Array<() => void> = [];

  const stop = (): void => {
    if (stopped.value) {
      return;
    }
    stopped.value = true;
    for (const fn of teardownFns) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    teardownFns.length = 0;
  };

  for (const watch of watches) {
    const { udid, socket, rsdProbe } = watch;
    let finalized = false;

    const finalize = async (reason: string): Promise<void> => {
      if (finalized || stopped.value) {
        return;
      }
      finalized = true;

      if (!registry.tunnels[udid]) {
        return;
      }

      const address = registry.tunnels[udid].address;

      delete registry.tunnels[udid];
      log.info(
        `Tunnel registry: removed ${udid} (${reason}). Remaining: ${Object.keys(registry.tunnels).length}`,
      );

      try {
        await onRemove?.(udid);
      } catch (err) {
        log.warn(`onRemove failed for ${udid}: ${err}`);
      }

      try {
        await onTunnelDead?.({ udid, address });
      } catch (err) {
        log.warn(`onTunnelDead failed for ${udid}: ${err}`);
      }
    };

    const onSocketEnd = (): void => {
      void finalize('upstream socket closed or errored');
    };

    socket.once('close', onSocketEnd);
    socket.once('error', onSocketEnd);

    teardownFns.push(() => {
      socket.off('close', onSocketEnd);
      socket.off('error', onSocketEnd);
    });

    if (
      rsdProbe &&
      rsdProbeIntervalMs > 0 &&
      rsdProbe.port > 0 &&
      rsdProbe.host
    ) {
      startRsdProbeLoop({
        host: rsdProbe.host,
        port: rsdProbe.port,
        intervalMs: rsdProbeIntervalMs,
        connectTimeoutMs: rsdProbeConnectTimeoutMs,
        failureThreshold: rsdProbeFailureThreshold,
        shouldStop: () => stopped.value || finalized,
        onFinalize: finalize,
        registerTeardown: (cancel) => {
          teardownFns.push(cancel);
        },
      });
    }
  }

  return { stop };
}

/**
 * Run RSD probes sequentially: wait for each probe to finish, then wait
 * `intervalMs` before starting the next (no overlapping TCP connects).
 */
function startRsdProbeLoop(options: RsdProbeLoopOptions): void {
  const {
    host,
    port,
    intervalMs,
    connectTimeoutMs,
    failureThreshold,
    shouldStop,
    onFinalize,
    registerTeardown,
  } = options;

  let consecutiveProbeFailures = 0;
  let nextProbeTimer: NodeJS.Timeout | undefined;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (nextProbeTimer !== undefined) {
      clearTimeout(nextProbeTimer);
      nextProbeTimer = undefined;
    }
  };

  const scheduleNext = (): void => {
    if (cancelled || shouldStop()) {
      return;
    }
    nextProbeTimer = setTimeout(() => {
      nextProbeTimer = undefined;
      void runProbeCycle();
    }, intervalMs);
  };

  const runProbeCycle = async (): Promise<void> => {
    if (cancelled || shouldStop()) {
      return;
    }

    if (!isRsdDiscoveryBusy(host, port)) {
      const result = await probeRsd(host, port, connectTimeoutMs);
      if (result === 'reachable') {
        consecutiveProbeFailures = 0;
      } else if (result === 'unreachable') {
        consecutiveProbeFailures += 1;
        if (
          consecutiveProbeFailures >= failureThreshold &&
          !cancelled &&
          !shouldStop()
        ) {
          await onFinalize(
            `RSD probe failed (${consecutiveProbeFailures} consecutive)`,
          );
          return;
        }
      }
    }

    scheduleNext();
  };

  registerTeardown(cancel);
  void runProbeCycle();
}

/**
 * Probe an RSD socket endpoint.
 *
 * - `reachable`: TCP connect succeeded, or the host reset the probe (`ECONNRESET` /
 *   `EPIPE`) — `remoted` is present but may be busy (see issue #208).
 * - `inconclusive`: probe timed out or returned a soft error; do not count toward removal.
 * - `unreachable`: explicit down signals (`ECONNREFUSED`, `ENETUNREACH`, …).
 */
function probeRsd(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<'reachable' | 'unreachable' | 'inconclusive'> {
  if (!host || port <= 0) {
    return Promise.resolve('unreachable');
  }

  return new Promise((resolve) => {
    const socket = createConnection(rsdConnectOptions(host, port));
    let settled = false;

    const finish = (
      result: 'reachable' | 'unreachable' | 'inconclusive',
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish('inconclusive'), timeoutMs);

    socket.once('connect', () => finish('reachable'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      log.info(`RSD probe error: ${JSON.stringify(err)}`);
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        finish('reachable');
        return;
      }
      if (
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENETUNREACH' ||
        err.code === 'EHOSTUNREACH'
      ) {
        finish('unreachable');
        return;
      }
      finish('inconclusive');
    });
  });
}

function rsdConnectOptions(
  host: string,
  port: number,
): { host: string; port: number; family?: 6 } {
  if (host.includes(':')) {
    return { host, port, family: 6 };
  }
  return { host, port };
}
