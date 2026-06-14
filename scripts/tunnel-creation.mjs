#!/usr/bin/env node
/**
 * Create lockdown + CoreDeviceProxy tunnels for connected USB devices and expose the tunnel registry API.
 */

import { logger } from '@appium/support';
import { Command } from 'commander';

import {
  TunnelManager,
  TunnelReadinessCoordinator,
  createLockdownServiceByUDID,
  createUsbmux,
  discoverServices,
  servicesToCatalog,
  startCoreDeviceProxyTcp,
  startTunnelRegistryServer,
  watchTunnelRegistryOnDead,
} from 'appium-ios-remotexpc';
import { DEFAULT_TUNNEL_REGISTRY_PORT } from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('TunnelCreation');

/** @type {import('appium-ios-remotexpc').TunnelRegistryServer | null} */
let registryServer = null;

/** @type {Map<string, TunnelCreationSuccessResult>} */
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
  const udid = result.device.Properties.SerialNumber;
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

function connectionTypeRank(connectionType) {
  if (connectionType === 'USB') {
    return 0;
  }
  if (connectionType === 'Network') {
    return 1;
  }
  return 2;
}

/**
 * usbmux may list the same UDID twice (USB + Network). Prefer USB for tunneling.
 *
 * @param {import('appium-ios-remotexpc').UsbmuxDevice[]} devices
 */
function dedupeDevicesByUdid(devices) {
  const byUdid = new Map();
  for (const device of devices) {
    const udid = device.Properties.SerialNumber;
    const existing = byUdid.get(udid);
    if (!existing) {
      byUdid.set(udid, device);
      continue;
    }
    if (
      connectionTypeRank(device.Properties.ConnectionType) <
      connectionTypeRank(existing.Properties.ConnectionType)
    ) {
      byUdid.set(udid, device);
    }
  }
  return [...byUdid.values()];
}

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

function buildTunnelEntryBase(result, existing) {
  const udid = result.device.Properties.SerialNumber;
  const now = Date.now();
  const entry = {
    udid,
    deviceId: result.device.DeviceID,
    address: result.tunnel.Address,
    rsdPort: result.tunnel.RsdPort,
    services: {},
    connectionType: result.device.Properties.ConnectionType,
    productId: result.device.Properties.ProductID,
    createdAt: existing?.createdAt ?? now,
    lastUpdated: now,
  };
  return entry;
}

async function publishDiscoveredTunnelEntry(result) {
  if (!registryServer) {
    throw new Error('Registry server is not started');
  }

  const udid = result.device.Properties.SerialNumber;
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
  const entry = buildTunnelEntryBase(result, registry.tunnels[udid]);
  entry.services = servicesToCatalog(services);
  entry.catalogUpdatedAt = now;

  registryServer.upsertReadyEntry(udid, entry);
  log.info(
    `Published tunnel catalog for ${udid} (${Object.keys(entry.services).length} services)`,
  );
  return true;
}

const registryWatcherStops = [];
/** @type {Map<string, Promise<void>>} */
const reconnectingByUdid = new Map();

/**
 * When the native forwarder exits, drop the UDID from the HTTP registry and tear down state.
 *
 * @param {object} registry
 * @param {TunnelCreationSuccessResult[]} successful
 */
function attachTunnelRegistryLifecycleWatch(registry, successful, callbacks = {}) {
  for (const result of successful) {
    const udid = result.device.Properties.SerialNumber;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReconnectAttempts({
  udid,
  maxRetries,
  device,
  reconnectTunnelByUdid,
}) {
  let attempt = 0;
  while (maxRetries === 0 || attempt < maxRetries) {
    attempt += 1;
    log.warn(
      `Reconnecting dropped tunnel for ${udid} (attempt ${attempt}${maxRetries === 0 ? ', unlimited mode' : `/${maxRetries}`})...`,
    );

    registryServer?.markTunnelPending(udid);

    const result = await createTunnelForDevice(device);
    if (result.success) {
      attachTunnelRegistryLifecycleWatch(
        registryServer.getRegistry(),
        [result],
        {
          onTunnelDead: async ({ udid: droppedUdid }) => {
            await reconnectTunnelByUdid(droppedUdid);
          },
        },
      );
      const ok = await publishDiscoveredTunnelEntry(result);
      if (ok) {
        log.info(`Reconnected tunnel for ${udid}`);
      }
      return;
    }

    await sleep(1000);
  }

  log.error(`Reconnect retries exhausted for ${udid}`);
}

function createReconnectTunnelByUdid({
  reconnectRetries,
  devicesByUdid,
}) {
  return async function reconnectTunnelByUdid(udid) {
    if (typeof reconnectRetries !== 'number') {
      return;
    }
    if (reconnectingByUdid.has(udid)) {
      return reconnectingByUdid.get(udid);
    }

    const device = devicesByUdid.get(udid);
    if (!device) {
      log.warn(`Cannot reconnect ${udid}: device context not found`);
      return;
    }

    const run = runReconnectAttempts({
      udid,
      maxRetries: reconnectRetries,
      device,
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

function setupCleanupHandlers() {
  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

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

    log.info('Cleanup completed.');
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

async function createTunnelForDevice(device) {
  const udid = device.Properties.SerialNumber;

  try {
    log.info(`\n--- Processing device: ${udid} ---`);
    log.info(`Device ID: ${device.DeviceID}`);
    log.info(`Connection Type: ${device.Properties.ConnectionType}`);
    log.info(`Product ID: ${device.Properties.ProductID}`);

    log.info('Creating lockdown service...');
    const { lockdownService, device: lockdownDevice } =
      await createLockdownServiceByUDID(udid);
    log.info(
      `Lockdown service created for device: ${lockdownDevice.Properties.SerialNumber}`,
    );

    log.info('Starting CoreDeviceProxy (raw TCP, native OpenSSL forwarder)...');
    const { socket, cert, key } = await startCoreDeviceProxyTcp(
      lockdownService,
      lockdownDevice.DeviceID,
      lockdownDevice.Properties.SerialNumber,
    );
    log.info('CoreDeviceProxy started successfully');

    log.info(`Creating tunnel...`);
    const lifecycle = { notify: null };
    const tunnelConnection = await TunnelManager.getTunnel(
      socket,
      { cert, key },
      {
        onDead: (reason) => lifecycle.notify?.(reason),
      },
    );
    log.info(
      `Tunnel created for address: ${tunnelConnection.Address} with RsdPort: ${tunnelConnection.RsdPort}`,
    );

    log.info(`✅ Tunnel creation completed successfully for device: ${udid}`);
    log.info(`   Tunnel Address: ${tunnelConnection.Address}`);
    log.info(`   Tunnel RsdPort: ${tunnelConnection.RsdPort}`);

    const result = {
      device,
      tunnel: {
        Address: tunnelConnection.Address,
        RsdPort: tunnelConnection.RsdPort,
      },
      success: true,
      tunnelConnection,
      registerOnDead: (handler) => {
        lifecycle.notify = handler;
      },
    };

    registerEstablishedTunnel(result);
    return result;
  } catch (error) {
    const errorMessage = `Failed to create tunnel for device ${udid}: ${error}`;
    log.error(`❌ ${errorMessage}`);
    return {
      device,
      tunnel: { Address: '', RsdPort: 0 },
      success: false,
      error: errorMessage,
    };
  }
}

async function main() {
  setupCleanupHandlers();

  const program = new Command();
  program
    .name('tunnel-creation')
    .description(
      'Create tunnels for connected USB devices (lockdown + CoreDeviceProxy)',
    )
    .argument('[udid]', 'Optional device UDID (omit for all devices)')
    .option('--udid <udid>', 'UDID of the device to create tunnel for')
    .option('-k, --keep-open', 'Keep connections open for lsof inspection')
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
  const specificUdid = options.udid ?? program.args[0] ?? undefined;

  if (specificUdid) {
    log.info(
      `Starting tunnel creation test for specific UDID: ${specificUdid}`,
    );
  } else {
    log.info('Starting tunnel creation test for all connected devices');
  }

  if (options.keepOpen) {
    log.info('Running in "keep connections open" mode for lsof inspection');
  }

  const registryPort =
    options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;

  try {
    log.info('Connecting to usbmuxd...');
    const usbmux = await createUsbmux();

    log.info('Listing all connected devices...');
    const devices = await usbmux.listDevices();

    await usbmux.close();

    if (devices.length === 0) {
      log.warn(
        'No devices found. Make sure iOS devices are connected and trusted.',
      );
      process.exit(0);
    }

    log.info(`Found ${devices.length} connected device(s):`);
    devices.forEach((device, index) => {
      log.info(`  ${index + 1}. UDID: ${device.Properties.SerialNumber}`);
      log.info(`     Device ID: ${device.DeviceID}`);
      log.info(`     Connection: ${device.Properties.ConnectionType}`);
      log.info(`     Product ID: ${device.Properties.ProductID}`);
    });

    let devicesToProcess = devices;
    if (specificUdid) {
      devicesToProcess = devices.filter(
        (device) => device.Properties.SerialNumber === specificUdid,
      );

      if (devicesToProcess.length === 0) {
        log.error(
          `Device with UDID ${specificUdid} not found in connected devices.`,
        );
        log.error('Available devices:');
        devices.forEach((device) => {
          log.error(`  - ${device.Properties.SerialNumber}`);
        });
        process.exit(1);
      }
    }

    const beforeDedupe = devicesToProcess.length;
    devicesToProcess = dedupeDevicesByUdid(devicesToProcess);
    if (devicesToProcess.length < beforeDedupe) {
      log.info(
        `Deduped ${beforeDedupe} usbmux entries to ${devicesToProcess.length} device(s) (USB preferred over Network)`,
      );
    }

    log.info(`\nProcessing ${devicesToProcess.length} device(s)...`);

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

    const reconnectRetries = options.reconnectRetries;
    const devicesByUdid = new Map(
      devicesToProcess.map((device) => [device.Properties.SerialNumber, device]),
    );
    const reconnectTunnelByUdid = createReconnectTunnelByUdid({
      reconnectRetries,
      devicesByUdid,
    });

    const results = [];
    const successful = [];

    for (const device of devicesToProcess) {
      const result = await createTunnelForDevice(device);
      results.push(result);

      if (result.success) {
        attachTunnelRegistryLifecycleWatch(
          registryServer.getRegistry(),
          [result],
          {
            onTunnelDead: async ({ udid }) => {
              await reconnectTunnelByUdid(udid);
            },
          },
        );
        const published = await publishDiscoveredTunnelEntry(result);
        if (published) {
          successful.push(result);
        }
      }

      if (devicesToProcess.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    log.info('\n=== TUNNEL CREATION SUMMARY ===');
    const failed = results.filter((r) => !r.success);

    log.info(`Total devices processed: ${results.length}`);
    log.info(`Successful tunnels: ${successful.length}`);
    log.info(`Failed tunnels: ${failed.length}`);

    if (successful.length > 0) {
      log.info('\n✅ Successful tunnels:');
      log.info('\n📁 Tunnel registry API:');
      log.info('   The tunnel registry is now available through the API at:');
      log.info(`   http://localhost:${registryPort}/remotexpc/tunnels`);
      log.info('\n   Available endpoints:');
      log.info('   - GET /remotexpc/tunnels - List all tunnels');
      log.info(
        '   - GET /remotexpc/tunnels/:udid?waitMs=15000 - Get tunnel (long-poll until catalog ready)',
      );
      log.info(
        '   - POST /remotexpc/tunnels/:udid/refresh-services - Re-discover RSD catalog',
      );
      log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

      log.info('\n💡 Example usage:');
      log.info(
        `   curl http://localhost:${registryPort}/remotexpc/tunnels`,
      );
      log.info(
        `   curl http://localhost:${registryPort}/remotexpc/tunnels/metadata`,
      );
      const firstUdid = successful[0].device.Properties.SerialNumber;
      log.info(
        `   curl "http://localhost:${registryPort}/remotexpc/tunnels/${firstUdid}?waitMs=15000"`,
      );
    }
  } catch (error) {
    log.error(`Error during tunnel creation test: ${error}`);
    throw error;
  }
}

await main();

/**
 * Successful tunnel row (USB lockdown + CoreDeviceProxy) used for the registry and lifecycle watch.
 *
 * @typedef {object} TunnelCreationSuccessResult
 * @property {{ Properties: { SerialNumber: string }, DeviceID: number }} device
 * @property {{ Address: string, RsdPort?: number }} tunnel
 * @property {import('appium-ios-tuntap').TunnelConnection} tunnelConnection
 * @property {(handler: (reason: string) => void) => void} registerOnDead
 */
