import type {Socket} from 'node:net';
import type {TLSSocket} from 'node:tls';

import {getLogger} from '../logger.js';
import type {TunnelRegistry} from '../types.js';

const log = getLogger('TunnelRegistryLifecycle');

export interface TunnelRegistrySocketWatch {
  udid: string;
  /** CoreDeviceProxy (or equivalent) TLS socket; when it closes, the tunnel is gone. */
  socket: Socket | TLSSocket;
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
  onTunnelDead?: (ctx: {udid: string; address: string}) => void | Promise<void>;
}

export interface TunnelRegistryOnDeadWatch {
  udid: string;
  /** Register a handler invoked when the native forwarder exits unexpectedly. */
  registerOnDead: (handler: (reason: string) => void) => void;
}

export interface WatchTunnelRegistryOnDeadOptions {
  registry: TunnelRegistry;
  watches: TunnelRegistryOnDeadWatch[];
  onRemove?: (udid: string) => void | Promise<void>;
  onTunnelDead?: (ctx: {udid: string; address: string}) => void | Promise<void>;
}

/**
 * Removes a tunnel from the registry when its upstream CoreDeviceProxy socket dies.
 *
 * @returns `stop` — clears listeners (e.g. for tests or shutdown).
 */
export function watchTunnelRegistrySockets(options: WatchTunnelRegistryOptions): {stop: () => void} {
  const {registry, watches, onRemove, onTunnelDead} = options;

  const stopped = {value: false};
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
    const {udid, socket} = watch;
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
      log.info(`Tunnel registry: removed ${udid} (${reason}). Remaining: ${Object.keys(registry.tunnels).length}`);

      try {
        await onRemove?.(udid);
      } catch (err) {
        log.warn(`onRemove failed for ${udid}: ${err}`);
      }

      try {
        await onTunnelDead?.({udid, address});
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
  }

  return {stop};
}

/**
 * Removes a tunnel from the registry when its native forwarder dies (lockdown or TLS-PSK).
 */
export function watchTunnelRegistryOnDead(options: WatchTunnelRegistryOnDeadOptions): {stop: () => void} {
  const {registry, watches, onRemove, onTunnelDead} = options;

  const stopped = {value: false};
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
    const {udid} = watch;
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
      log.info(`Tunnel registry: removed ${udid} (${reason}). Remaining: ${Object.keys(registry.tunnels).length}`);

      try {
        await onRemove?.(udid);
      } catch (err) {
        log.warn(`onRemove failed for ${udid}: ${err}`);
      }

      try {
        await onTunnelDead?.({udid, address});
      } catch (err) {
        log.warn(`onTunnelDead failed for ${udid}: ${err}`);
      }
    };

    watch.registerOnDead((reason) => {
      void finalize(`native forwarder died: ${reason}`);
    });

    teardownFns.push(() => {
      watch.registerOnDead(() => {});
    });
  }

  return {stop};
}
