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
  discoverServices,
  servicesToCatalog,
  startTunnelRegistryServer,
  watchTunnelRegistryOnDead,
} from 'appium-ios-remotexpc';
import { DEFAULT_TUNNEL_REGISTRY_PORT } from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('WiFiTunnel');

/** @type {import('appium-ios-remotexpc').TunnelRegistryServer | null} */
let registryServer = null;

const registryWatcherStops = [];
/** @type {Map<string, Promise<void>>} */
const reconnectingByUdid = new Map();
/** @type {Map<string, AppleTvEstablishedTunnel>} */
const establishedTunnelsByUdid = new Map();

/** @type {Map<string, () => void>} */
const lifecycleWatchStopByUdid = new Map();

async function closeTunnelQuietly(tunnelConnection) {
  try {
    await tunnelConnection.closer();
  } catch {
    // superseded tunnel may already be stopped
  }
}

function stopLifecycleWatch(udid) {
  const stop = lifecycleWatchStopByUdid.get(udid);
  if (stop) {
    stop();
    lifecycleWatchStopByUdid.delete(udid);
  }
}

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
let tunnelService = null;

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid port: ${value}. Expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

function parseNonNegativeInteger(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(
      `Invalid retry count: ${value}. Expected a non-negative integer (0 = unlimited).`,
    );
  }
  return count;
}

function parsePositiveInteger(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(
      `Invalid timeout: ${value}. Expected a positive integer in milliseconds.`,
    );
  }
  return count;
}

/**
 * @param {object} registry
 * @param {AppleTvEstablishedTunnel[]} successfulResults
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

function setupCleanupHandlers() {
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
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cleanup('SIGTERM');
    process.exit(0);
  });
  process.on('SIGHUP', async () => {
    await cleanup('SIGHUP');
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    log.error('Uncaught Exception:', error);
    await cleanup('Uncaught Exception');
  });

  process.on('unhandledRejection', async (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await cleanup('Unhandled Rejection');
  });
}

/**
 * @param {{ tcpSocket: import('net').Socket; psk: Buffer; device: { identifier: string; name?: string } }} startResult
 * @returns {Promise<AppleTvEstablishedTunnel>}
 */
async function establishOneTunnel(startResult) {
  const { tcpSocket, psk, device } = startResult;
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
    registerOnDead: (handler) => {
      lifecycle.notify = handler;
    },
  };

  registerEstablishedTunnel(result);
  return result;
}

async function refreshServiceCatalog(udid, entry) {
  log.info(`Refreshing RSD service catalog for ${udid}...`);
  const services = await discoverServices(udid, entry.address, entry.rsdPort);
  const now = Date.now();
  return {
    ...entry,
    services: servicesToCatalog(services),
    catalogUpdatedAt: now,
    lastUpdated: now,
  };
}

function buildAppleTvTunnelEntryBase(result, existing) {
  const udid = result.device.identifier;
  const now = Date.now();
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

async function publishDiscoveredTunnelEntry(result) {
  if (!registryServer) {
    throw new Error('Registry server is not started');
  }

  const udid = result.device.identifier;
  const rsdPort = result.tunnel.RsdPort;
  if (typeof rsdPort !== 'number' || rsdPort <= 0) {
    log.warn(
      `Skipping registry entry for ${udid}: no valid RSD port (got ${String(rsdPort)})`,
    );
    return false;
  }

  registryServer.markTunnelPending(udid);
  log.info(
    `Discovering RSD services for ${udid} at ${result.tunnel.Address}:${rsdPort}...`,
  );

  const services = await discoverServices(
    udid,
    result.tunnel.Address,
    rsdPort,
  );
  const now = Date.now();
  const registry = registryServer.getRegistry();
  const entry = buildAppleTvTunnelEntryBase(result, registry.tunnels[udid]);
  entry.services = servicesToCatalog(services);
  entry.catalogUpdatedAt = now;

  registryServer.upsertReadyEntry(udid, entry);
  log.info(
    `Published tunnel catalog for ${udid} (${Object.keys(entry.services).length} services)`,
  );
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      parsePort,
    )
    .option(
      '--reconnect-retries <count>',
      'Reconnect retries after unexpected tunnel drop (0 = unlimited)',
      parseNonNegativeInteger,
    )
    .option(
      '--discovery-timeout <ms>',
      'Apple TV discovery timeout in milliseconds',
      parsePositiveInteger,
    );

  program.parse(process.argv);
  const options = program.opts();
  const deviceIdentifier = program.args[0];
  const registryPort =
    options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;

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
    const registry = {
      tunnels: {},
      metadata: {
        lastUpdated: new Date().toISOString(),
        totalTunnels: 0,
        activeTunnels: 0,
      },
    };

    registryServer = await startTunnelRegistryServer(registry, registryPort, {
      readiness,
      refreshServices: refreshServiceCatalog,
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
      const devices = await tunnelService.discoverDevices({
        timeoutMs: options.discoveryTimeout,
      });
      log.info(
        `Discovered ${devices.length} Apple TV device(s); establishing tunnels...`,
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

    log.info('\n✅ Apple TV tunnel(s) ready.');
    log.info('\nPress Ctrl+C to close tunnel(s) and exit.');

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
