#!/usr/bin/env node
/**
 * Start Apple TV Remote XPC tunnel(s) and expose the tunnel registry HTTP API.
 * With [deviceIdentifier], opens one tunnel to that device. Without it, discovers
 * all Remote Pairing Apple TVs and opens one tunnel per device (skips failures).
 */

import { logger, util } from '@appium/support';
import { Command } from 'commander';
import {
  AppleTVTunnelService,
  TunnelManager,
  TunnelReadinessCoordinator,
  startTunnelRegistryServer,
  watchTunnelRegistryOnDead,
} from 'appium-ios-remotexpc';
import {
  parseNonNegativeIntegerOption,
  parsePortOption,
  parsePositiveIntegerOption,
} from './lib/options.mjs';
import { sleep } from './lib/timers.mjs';
import {
  createEmptyTunnelRegistry,
  publishDiscoveredTunnelEntry as publishTunnelRegistryEntry,
  refreshServiceCatalog,
} from './lib/tunnel-registry.mjs';
import { DEFAULT_TUNNEL_REGISTRY_PORT, DEFAULT_WIRELESS_APPLETV_DISCOVERY_TIMEOUT_MS } from './lib/constants.mjs';
import { assertRoot } from './lib/root.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTimeoutProgressLogger } from './lib/progress.mjs';

const log = logger.getLogger('WiFiTunnel');

const APPLETV_TUNNEL_DISCOVERY_PROGRESS_INTERVAL_MS = 1000;
const APPLETV_TUNNEL_DISCOVERY_PROGRESS_BAR_WIDTH = 24;

/** @type {import('appium-ios-remotexpc').TunnelRegistryServer | null} */
let registryServer = null;

/** @type {(() => void)[]} */
const registryWatcherStops = [];
/** @type {Map<string, Promise<void>>} */
const reconnectingByUdid = new Map();
/** @type {Map<string, AppleTvEstablishedTunnel>} */
const establishedTunnelsByUdid = new Map();

/** @type {Map<string, () => void>} */
const lifecycleWatchStopByUdid = new Map();

/**
 * @param {import('appium-ios-tuntap').TunnelConnection} tunnelConnection
 * @returns {Promise<void>}
 */
async function closeTunnelQuietly(tunnelConnection) {
  try {
    await tunnelConnection.closer();
  } catch {
    // superseded tunnel may already be stopped
  }
}

/**
 * @param {string} udid
 * @returns {void}
 */
function stopLifecycleWatch(udid) {
  const stop = lifecycleWatchStopByUdid.get(udid);
  if (stop) {
    stop();
    lifecycleWatchStopByUdid.delete(udid);
  }
}

/**
 *
 * @param {import('appium-ios-remotexpc').AppleTVTunnelService} tunnelService
 * @param {number} timeoutMs
 * @returns {{ startedAt: number, promise: Promise<AppleTVDevice[]> }}
 */
function startDevicesDiscovery(tunnelService, timeoutMs) {
  const startedAt = performance.now();
  const promise = tunnelService.discoverDevices({ timeoutMs });
  return { startedAt, promise };
}

/**
 *
 * @param {{ startedAt: number, promise: Promise<AppleTVDevice[]> }} discovery
 * @param {number} timeoutMs
 * @returns {Promise<AppleTVDevice[]>}
 */
async function waitForDevicesDiscovery(discovery, timeoutMs) {
  const progress = startTimeoutProgressLogger({
    log,
    label: 'Waiting for wireless Apple TV devices discovery',
    startedAt: discovery.startedAt,
    timeoutMs,
    barWidth: APPLETV_TUNNEL_DISCOVERY_PROGRESS_BAR_WIDTH,
    intervalMs: APPLETV_TUNNEL_DISCOVERY_PROGRESS_INTERVAL_MS,
  });

  try {
    const devices = await discovery.promise;
    progress.succeed(
      `Wireless Apple TV devices discovery completed: ${util.pluralize('device', devices.length, true)} found`,
    );
    return devices;
  } catch (err) {
    progress.fail('Wireless Apple TV devices discovery failed');
    throw err;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNoDevicesFoundError(err) {
  return err instanceof Error && ('code' in err && err.code === 'NO_DEVICES') || /** @type {Error} */ (err).message?.includes('No devices found');
}

/**
 * @param {AppleTvEstablishedTunnel} result
 * @returns {void}
 */
function registerEstablishedTunnel(result) {
  const udid = result.device.identifier;
  stopLifecycleWatch(udid);

  const previous = establishedTunnelsByUdid.get(udid);
  if (
    previous?.tunnelConnection &&
    previous.tunnelConnection !== result.tunnelConnection
  ) {
    void closeTunnelQuietly(previous.tunnelConnection);
  }
  establishedTunnelsByUdid.set(udid, result);
}

/** @type {import('appium-ios-remotexpc').AppleTVTunnelService | null} */
let tunnelService = null;

/**
 * @param {import('appium-ios-remotexpc').TunnelRegistry} registry
 * @param {AppleTvEstablishedTunnel[]} successfulResults
 * @param {object} callbacks
 * @param {function({ udid: string, address: string }): Promise<void>} [callbacks.onTunnelDead]
 */
function attachAppleTvTunnelRegistryLifecycleWatch(registry, successfulResults, callbacks = {}) {
  for (const result of successfulResults) {
    const udid = result.device.identifier;
    stopLifecycleWatch(udid);

    const { stop } = watchTunnelRegistryOnDead({
      registry,
      watches: [
        {
          udid,
          registerOnDead: result.registerOnDead,
        },
      ],
      onRemove: async (removedUdid) => {
        registryServer?.removeTunnelEntry(removedUdid);
      },
      onTunnelDead: async ({ udid: droppedUdid, address }) => {
        await TunnelManager.closeTunnelByAddress(address).catch(() => {});
        if (callbacks.onTunnelDead) {
          await callbacks.onTunnelDead({ udid: droppedUdid, address });
        }
      },
    });
    registryWatcherStops.push(stop);
    lifecycleWatchStopByUdid.set(udid, stop);
  }

  log.info(
    'Tunnel registry will update automatically if a native forwarder exits unexpectedly.',
  );
}

/**
 * @returns {void}
 */
function setupCleanupHandlers() {
  /**
   * @param {string} signal
   * @returns {Promise<void>}
   */
  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

    try {
      while (registryWatcherStops.length > 0) {
        const stop = registryWatcherStops.pop();
        try {
          stop?.();
        } catch {}
      }
      lifecycleWatchStopByUdid.clear();

      for (const { tunnelConnection } of establishedTunnelsByUdid.values()) {
        try {
          if (tunnelConnection && typeof tunnelConnection.closer === 'function') {
            log.info('Closing tunnel...');
            await tunnelConnection.closer();
          }
        } catch (err) {
          log.warn(`Error closing tunnel: ${err}`);
        }
      }
      establishedTunnelsByUdid.clear();

      if (tunnelService) {
        tunnelService.disconnect();
      }

      log.info('Cleanup completed.');
    } catch (err) {
      log.error('Error during cleanup:', err);
    }
  };

  process.on('SIGINT', async () => {
    await cleanup('SIGINT (Ctrl+C)');
    process.exit(process.exitCode || 0);
  });
  process.on('SIGTERM', async () => {
    await cleanup('SIGTERM');
    process.exit(process.exitCode || 0);
  });
  process.on('SIGHUP', async () => {
    await cleanup('SIGHUP');
    process.exit(process.exitCode || 0);
  });

  process.on('uncaughtException', async (error) => {
    log.error('Uncaught Exception:', error);
    await cleanup('Uncaught Exception');
    process.exit(process.exitCode || 1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await cleanup('Unhandled Rejection');
    process.exit(process.exitCode || 1);
  });
}

/**
 * @param {{ tcpSocket: import('net').Socket; psk: Buffer; device: { identifier: string; name?: string } }} startResult
 * @returns {Promise<AppleTvEstablishedTunnel>}
 */
async function establishOneTunnel(startResult) {
  const { tcpSocket, psk, device } = startResult;
  /** @type {{ notify: ((reason: string) => void) | null }} */
  const lifecycle = { notify: null };

  const tunnelConnection = await TunnelManager.getTunnelPsk(
    tcpSocket,
    { psk },
    {
      onDead: (reason) => lifecycle.notify?.(reason),
    },
  );

  const result = {
    device,
    tunnel: {
      Address: tunnelConnection.Address,
      RsdPort: tunnelConnection.RsdPort,
    },
    tunnelConnection,
    /**
     * @param {(reason: string) => void} handler
     * @returns {void}
     */
    registerOnDead: (handler) => {
      lifecycle.notify = handler;
    },
  };

  registerEstablishedTunnel(result);
  return result;
}

/**
 * @param {AppleTvEstablishedTunnel} result
 * @param {import('appium-ios-remotexpc').TunnelRegistryEntry | undefined} existing
 * @param {number} now
 * @returns {import('appium-ios-remotexpc').TunnelRegistryEntry}
 */
function buildAppleTvTunnelEntry(result, existing, now) {
  const udid = result.device.identifier;
  const entry = {
    udid,
    deviceId: 0,
    address: result.tunnel.Address,
    rsdPort: result.tunnel.RsdPort,
    services: {},
    connectionType: 'WiFi',
    productId: 0,
    createdAt: existing?.createdAt ?? now,
    lastUpdated: now,
  };
  return entry;
}

/**
 *
 * @param {AppleTvEstablishedTunnel} result
 * @returns {Promise<boolean>}
 */
async function publishDiscoveredTunnelEntry(result) {
  return await publishTunnelRegistryEntry({
    registryServer,
    result,
    getUdid: (r) => r.device.identifier,
    buildEntry: buildAppleTvTunnelEntry,
    log,
  });
}

/**
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {number} opts.maxRetries
 * @param {import('appium-ios-remotexpc').AppleTVTunnelService} opts.tunnelService
 * @param {function(string): Promise<void>} opts.reconnectTunnelByUdid
 * @param {number} opts.discoveryTimeoutMs
 * @returns {Promise<void>}
 */
async function runAppleTvReconnectAttempts({
  udid,
  maxRetries,
  tunnelService,
  reconnectTunnelByUdid,
  discoveryTimeoutMs,
}) {
  let attempt = 0;
  while (maxRetries === 0 || attempt < maxRetries) {
    attempt += 1;
    log.warn(
      `Reconnecting dropped tunnel for ${udid} (attempt ${attempt}${maxRetries === 0 ? ', unlimited mode' : `/${maxRetries}`})...`,
    );
    registryServer?.markTunnelPending(udid);

    try {
      const result = await tunnelService.startTunnel(undefined, udid, {
        discoveryTimeoutMs,
      });
      if (!result.tcpSocket) {
        throw new Error('TCP socket to listener port not established');
      }
      const reconnected = await establishOneTunnel(result);
      const ok = await publishDiscoveredTunnelEntry(reconnected);
      if (ok && registryServer) {
        attachAppleTvTunnelRegistryLifecycleWatch(
          registryServer.getRegistry(),
          [reconnected],
          {
            onTunnelDead: async ({ udid: droppedUdid }) => {
              await reconnectTunnelByUdid(droppedUdid);
            },
          },
        );
        log.info(`Reconnected tunnel for ${udid}`);
      }
      return;
    } catch (err) {
      log.warn(`Reconnect attempt failed for ${udid}: ${err}`);
    }
    await sleep(1000);
  }
  log.error(`Reconnect retries exhausted for ${udid}`);
}

/**
 *
 * @param {object} opts
 * @param {number} opts.reconnectRetries
 * @param {import('appium-ios-remotexpc').AppleTVTunnelService} opts.tunnelService
 * @param {number} opts.discoveryTimeoutMs
 * @returns {function(string): Promise<void>}
 */
function createAppleTvReconnectTunnelByUdid({
  reconnectRetries,
  tunnelService,
  discoveryTimeoutMs,
}) {
  return async function reconnectTunnelByUdid(udid) {
    if (typeof reconnectRetries !== 'number') {
      return;
    }
    if (reconnectingByUdid.has(udid)) {
      return reconnectingByUdid.get(udid);
    }

    const run = runAppleTvReconnectAttempts({
      udid,
      maxRetries: reconnectRetries,
      tunnelService,
      reconnectTunnelByUdid,
      discoveryTimeoutMs,
    });

    reconnectingByUdid.set(udid, run);
    try {
      await run;
    } finally {
      reconnectingByUdid.delete(udid);
    }
  };
}

async function main() {
  setupCleanupHandlers();

  const program = new Command();
  program
    .name('start-appletv-tunnel')
    .description(
      'Open Wi-Fi Remote XPC tunnel(s) and serve the tunnel registry API. ' +
        'With [deviceIdentifier], only that Apple TV is used. Without it, one tunnel per discovered device.',
    )
    .argument(
      '[deviceIdentifier]',
      'Apple TV device identifier from discovery. Omit to tunnel every discovered device.',
    )
    .option(
      '--tunnel-registry-port <port>',
      `Port for tunnel registry API (default: ${DEFAULT_TUNNEL_REGISTRY_PORT})`,
      (value) => parsePortOption(value, 'tunnel registry port'),
    )
    .option(
      '--reconnect-retries <count>',
      'Reconnect retries after unexpected tunnel drop (0 = unlimited)',
      (value) => parseNonNegativeIntegerOption(value, 'retry count'),
    )
    .option(
      '--discovery-timeout <ms>',
      'Apple TV discovery timeout in milliseconds',
      (value) => parsePositiveIntegerOption(value, 'discovery timeout'),
    );

  program.parse(process.argv);
  const options = program.opts();
  const deviceIdentifier = program.args[0];
  const registryPort =
    options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;

  await assertRoot(path.join('scripts', path.basename(fileURLToPath(import.meta.url))));

  if (deviceIdentifier) {
    log.info(`Targeting a single Apple TV: ${deviceIdentifier}`);
  } else {
    log.info(
      'No device identifier: will open one tunnel per discovered Apple TV',
    );
  }

  tunnelService = new AppleTVTunnelService();

  try {
    const readiness = new TunnelReadinessCoordinator();
    const registry = createEmptyTunnelRegistry();

    registryServer = await startTunnelRegistryServer(registry, registryPort, {
      readiness,
      refreshServices: async (udid, entry) =>
        await refreshServiceCatalog(udid, entry, log),
    });

    const reconnectTunnelByUdid = createAppleTvReconnectTunnelByUdid({
      reconnectRetries: options.reconnectRetries,
      tunnelService,
      discoveryTimeoutMs: options.discoveryTimeout,
    });

    /** @type {AppleTvEstablishedTunnel[]} */
    const successfulResults = [];

    if (deviceIdentifier) {
      log.info('Starting Apple TV tunnel...');
      const result = await tunnelService.startTunnel(
        undefined,
        deviceIdentifier,
        {
          discoveryTimeoutMs: options.discoveryTimeout,
        },
      );
      if (!result.tcpSocket) {
        throw new Error('TCP socket to listener port not established');
      }
      const established = await establishOneTunnel(result);
      successfulResults.push(established);
      attachAppleTvTunnelRegistryLifecycleWatch(
        registryServer.getRegistry(),
        [established],
        {
          onTunnelDead: async ({ udid }) => {
            await reconnectTunnelByUdid(udid);
          },
        },
      );
    } else {
      const discoveryTimeoutMs = options.discoveryTimeout ?? DEFAULT_WIRELESS_APPLETV_DISCOVERY_TIMEOUT_MS;
      const discovery = startDevicesDiscovery(
        tunnelService,
        discoveryTimeoutMs,
      );
      /** @type {AppleTVDevice[]} */
      let devices = [];
      try {
        devices = await waitForDevicesDiscovery(
          discovery,
          discoveryTimeoutMs,
        );
      } catch (err) {
        if (isNoDevicesFoundError(err)) {
          log.info('No wireless Apple TV devices found');
          process.exit(process.exitCode || 0);
        }
        throw err;
      }
      log.info(
        `Discovered ${util.pluralize('Apple TV device', devices.length, true)}; establishing ${util.pluralize('tunnel', devices.length)}...`,
      );

      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        try {
          log.info(`\n--- ${d.identifier} (${d.name ?? 'Apple TV'}) ---`);
          const result = await tunnelService.startTunnel(
            undefined,
            d.identifier,
            {
              devices,
              discoveryTimeoutMs: options.discoveryTimeout,
            },
          );
          if (!result.tcpSocket) {
            throw new Error('TCP socket to listener port not established');
          }
          const established = await establishOneTunnel(result);
          successfulResults.push(established);
          attachAppleTvTunnelRegistryLifecycleWatch(
            registryServer.getRegistry(),
            [established],
            {
              onTunnelDead: async ({ udid }) => {
                await reconnectTunnelByUdid(udid);
              },
            },
          );
          log.info(`Tunnel established for ${d.identifier}`);
        } catch (err) {
          log.warn(`Skipping ${d.identifier}: ${err}`);
        }
        if (i < devices.length - 1) {
          await sleep(1000);
        }
      }
    }

    if (successfulResults.length === 0) {
      throw new Error('No tunnel could be established');
    }

    const registryPublished = [];
    for (const r of successfulResults) {
      const ok = await publishDiscoveredTunnelEntry(r);
      if (ok) {
        registryPublished.push(r);
      }
    }

    log.info(
      `\n=== ${util.pluralize('tunnel', registryPublished.length, true).toUpperCase()} IN REGISTRY ===`,
    );
    for (const r of registryPublished) {
      log.info(
        `${r.device.identifier}: ${r.tunnel.Address}:${r.tunnel.RsdPort}`,
      );
    }
    log.info('=============================');

    log.info('\n📁 Tunnel registry API:');
    log.info(
      `   http://localhost:${registryPort}/remotexpc/tunnels`,
    );
    log.info('   - GET /remotexpc/tunnels - List all tunnels');
    for (const r of registryPublished) {
      log.info(
        `   - GET /remotexpc/tunnels/${r.device.identifier}`,
      );
    }

    log.info(
      `\n✅ ${registryPublished.length} Apple TV ${util.pluralize('tunnel', registryPublished.length)} ready.`,
    );
    log.info(
      `\nPress Ctrl+C to close ${util.pluralize('tunnel', registryPublished.length)} and exit.`,
    );

    process.stdin.resume();
  } catch (error) {
    log.error('Tunnel failed:', error);
    throw error;
  }
}

await main();

/**
 * One fully established Apple TV tunnel (Remote XPC).
 *
 * @typedef {object} AppleTvEstablishedTunnel
 * @property {{ identifier: string, name?: string }} device
 * @property {{ Address: string, RsdPort?: number }} tunnel
 * @property {import('appium-ios-tuntap').TunnelConnection} tunnelConnection
 * @property {(handler: (reason: string) => void) => void} registerOnDead
 */

/**
 * @typedef {import('appium-ios-remotexpc').AppleTVDevice} AppleTVDevice
 */
