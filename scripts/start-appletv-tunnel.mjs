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
  watchTunnelRegistrySockets,
} from 'appium-ios-remotexpc';
import { DEFAULT_TUNNEL_REGISTRY_PORT } from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('WiFiTunnel');

/** @type {import('appium-ios-remotexpc').TunnelRegistryServer | null} */
let registryServer = null;

const registryWatcherStops = [];
/** @type {Map<string, Promise<void>>} */
const reconnectingByUdid = new Map();
/** @type {AppleTvEstablishedTunnel[]} */
const establishedTunnels = [];
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

/**
 * @param {object} registry
 * @param {AppleTvEstablishedTunnel[]} successfulResults
 */
function attachAppleTvTunnelRegistryLifecycleWatch(registry, successfulResults, callbacks = {}) {
  const watches = successfulResults
    .filter((r) => r.tlsSocket)
    .map((r) => {
      const watch = {
        udid: r.device.identifier,
        socket: r.tlsSocket,
      };
      return watch;
    });

  if (watches.length === 0) {
    return;
  }

  const { stop } = watchTunnelRegistrySockets({
    registry,
    watches,
    onRemove: async (udid) => {
      registryServer?.removeTunnelEntry(udid);
    },
    onTunnelDead: async ({ udid, address }) => {
      await TunnelManager.closeTunnelByAddress(address).catch(() => {});
      if (callbacks.onTunnelDead) {
        await callbacks.onTunnelDead({ udid, address });
      }
    },
  });
  registryWatcherStops.push(stop);
  log.info(
    'Tunnel registry will update automatically if a tunnel upstream socket goes away.',
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

      for (const { tunnel, tlsSocket } of establishedTunnels) {
        try {
          if (tunnel && typeof tunnel.closer === 'function') {
            log.info('Closing tunnel...');
            await tunnel.closer();
          }
        } catch (err) {
          log.warn(`Error closing tunnel: ${err}`);
        }
        if (tlsSocket && !tlsSocket.destroyed) {
          log.info('Closing TLS-PSK connection...');
          tlsSocket.destroy();
        }
      }
      establishedTunnels.length = 0;

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
 * @param {{ socket: import('tls').TLSSocket; device: { identifier: string; name?: string } }} startResult
 * @returns {Promise<AppleTvEstablishedTunnel>}
 */
async function establishOneTunnel(startResult) {
  const tlsSocket = startResult.socket;
  const device = startResult.device;

  log.info('Creating tunnel with TunnelManager...');
  const tunnel = await TunnelManager.getTunnel(tlsSocket);

  establishedTunnels.push({ tunnel, tlsSocket, device });

  return {
    device,
    tunnel,
    tlsSocket,
  };
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
}) {
  let attempt = 0;
  while (maxRetries === 0 || attempt < maxRetries) {
    attempt += 1;
    log.warn(
      `Reconnecting dropped tunnel for ${udid} (attempt ${attempt}${maxRetries === 0 ? ', unlimited mode' : `/${maxRetries}`})...`,
    );
    registryServer?.markTunnelPending(udid);

    try {
      const result = await tunnelService.startTunnel(undefined, udid);
      if (!result.socket) {
        throw new Error('TLS-PSK socket not established');
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
    /** @type {AppleTvEstablishedTunnel[]} */
    const successfulResults = [];

    if (deviceIdentifier) {
      log.info('Starting Apple TV tunnel...');
      const result = await tunnelService.startTunnel(undefined, deviceIdentifier);
      if (!result.socket) {
        throw new Error('TLS-PSK socket not established');
      }
      successfulResults.push(await establishOneTunnel(result));
    } else {
      const devices = await tunnelService.discoverDevices();
      log.info(
        `Discovered ${devices.length} Apple TV device(s); establishing tunnels...`,
      );

      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        try {
          log.info(`\n--- ${d.identifier} (${d.name ?? 'Apple TV'}) ---`);
          const result = await tunnelService.startTunnel(undefined, d.identifier);
          if (!result.socket) {
            throw new Error('TLS-PSK socket not established');
          }
          successfulResults.push(
            await establishOneTunnel(result),
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

    const registryPublished = [];
    for (const r of successfulResults) {
      const ok = await publishDiscoveredTunnelEntry(r);
      if (ok) {
        registryPublished.push(r);
      }
    }

    const reconnectTunnelByUdid = createAppleTvReconnectTunnelByUdid({
      reconnectRetries: options.reconnectRetries,
      tunnelService,
    });

    for (const r of registryPublished) {
      attachAppleTvTunnelRegistryLifecycleWatch(
        registryServer.getRegistry(),
        [r],
        {
          onTunnelDead: async ({ udid }) => {
            await reconnectTunnelByUdid(udid);
          },
        },
      );
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
 * @property {import('tls').TLSSocket} tlsSocket
 */
