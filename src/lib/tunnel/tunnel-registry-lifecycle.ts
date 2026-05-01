import { type Socket, createConnection } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { getLogger } from '../logger.js';
import type { TunnelRegistry } from '../types.js';

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
  /** Interval for RSD TCP probes; `0` disables (default: `5000`, 5 seconds). */
  rsdProbeIntervalMs?: number;
  /** Connect timeout per probe (default: `1000`, 1 second). */
  rsdProbeConnectTimeoutMs?: number;
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
    rsdProbeConnectTimeoutMs = 5_000,
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
      const probeTarget = rsdProbe;
      const id = setInterval(() => {
        if (stopped.value || finalized) {
          return;
        }
        void (async () => {
          const ok = await probeRsd(
            probeTarget.host,
            probeTarget.port,
            rsdProbeConnectTimeoutMs,
          );
          if (!ok && !stopped.value && !finalized) {
            await finalize('RSD probe failed');
          }
        })();
      }, rsdProbeIntervalMs);

      teardownFns.push(() => clearInterval(id));
    }
  }

  return { stop };
}

/**
 * Probe an RSD socket endpoint and resolve true when reachable.
 */
function probeRsd(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!host || port <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = createConnection({ host, port });

    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };

    const timer = setTimeout(() => {
      log.warn(`RSD probe ${host}:${port} timed out after ${timeoutMs}ms`);
      finish(false);
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      log.debug(`RSD probe ${host}:${port} connected`);
      finish(true);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      log.warn(`RSD probe ${host}:${port} error: ${err.message}`);
      finish(false);
    });
  });
}
