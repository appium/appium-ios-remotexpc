#!/usr/bin/env node
/**
 * Create lockdown + CoreDeviceProxy tunnels for connected USB devices and expose the tunnel registry API.
 */

import { logger } from '@appium/support';
import { Command } from 'commander';

import {
  PacketStreamServer,
  TunnelManager,
  createLockdownServiceByUDID,
  createUsbmux,
  startCoreDeviceProxy,
  startTunnelRegistryServer,
  watchTunnelRegistrySockets,
} from 'appium-ios-remotexpc';
import { DEFAULT_TUNNEL_REGISTRY_PORT } from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('TunnelCreation');

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid port: ${value}. Expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

async function updateTunnelRegistry(results) {
  const now = Date.now();
  const nowISOString = new Date().toISOString();

  const registry = {
    tunnels: {},
    metadata: {
      lastUpdated: nowISOString,
      totalTunnels: 0,
      activeTunnels: 0,
    },
  };

  for (const result of results) {
    if (result.success) {
      const udid = result.device.Properties.SerialNumber;
      const rsdPort = result.tunnel.RsdPort;
      if (typeof rsdPort !== 'number' || rsdPort <= 0) {
        log.warn(
          `Skipping registry entry for ${udid}: no valid RSD port (got ${String(rsdPort)})`,
        );
        continue;
      }
      const entry = {
        udid,
        deviceId: result.device.DeviceID,
        address: result.tunnel.Address,
        rsdPort,
        connectionType: result.device.Properties.ConnectionType,
        productId: result.device.Properties.ProductID,
        createdAt: registry.tunnels[udid]?.createdAt ?? now,
        lastUpdated: now,
      };
      const packetStreamPort = result.packetStreamPort;
      if (typeof packetStreamPort === 'number' && packetStreamPort > 0) {
        entry.packetStreamPort = packetStreamPort;
      }
      registry.tunnels[udid] = entry;
    }
  }

  registry.metadata = {
    lastUpdated: nowISOString,
    totalTunnels: Object.keys(registry.tunnels).length,
    activeTunnels: Object.keys(registry.tunnels).length,
  };

  return registry;
}

const packetStreamServers = new Map();
/** @type {{ stop: (() => void) | null }} */
const registryWatcherRef = { stop: null };

/**
 * When CoreDeviceProxy sockets or RSD go away, drop the UDID from the HTTP registry
 * and tear down packet streams / TunnelManager state.
 *
 * @param {object} registry
 * @param {TunnelCreationSuccessResult[]} successful
 */
function attachTunnelRegistryLifecycleWatch(registry, successful) {
  const watches = successful
    .filter((r) => r.socket)
    .map((r) => {
      const watch = {
        udid: r.device.Properties.SerialNumber,
        socket: r.socket,
      };
      const { Address, RsdPort } = r.tunnel;
      if (Address && typeof RsdPort === 'number' && RsdPort > 0) {
        watch.rsdProbe = { host: Address, port: RsdPort };
      }
      return watch;
    });

  if (watches.length === 0) {
    return;
  }

  const { stop } = watchTunnelRegistrySockets({
    registry,
    watches,
    onRemove: async (udid) => {
      const server = packetStreamServers.get(udid);
      if (server) {
        try {
          await server.stop();
          log.info(`Stopped packet stream server after tunnel loss: ${udid}`);
        } catch (err) {
          log.warn(
            `Failed to stop packet stream server for ${udid}: ${err}`,
          );
        }
        packetStreamServers.delete(udid);
      }
    },
    onTunnelDead: async ({ address }) => {
      await TunnelManager.closeTunnelByAddress(address).catch(() => {});
    },
  });
  registryWatcherRef.stop = stop;
  log.info(
    'Tunnel registry will update automatically if a tunnel or RSD endpoint goes away.',
  );
}

function setupCleanupHandlers() {
  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

    if (typeof registryWatcherRef.stop === 'function') {
      registryWatcherRef.stop();
      registryWatcherRef.stop = null;
    }

    if (packetStreamServers.size > 0) {
      log.info(
        `Closing ${packetStreamServers.size} packet stream server(s)...`,
      );
      for (const [udid, server] of packetStreamServers) {
        try {
          await server.stop();
          log.info(`Closed packet stream server for device ${udid}`);
        } catch (err) {
          log.warn(
            `Failed to close packet stream server for device ${udid}: ${err}`,
          );
        }
      }
      packetStreamServers.clear();
    }

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

async function createTunnelForDevice(device, tlsOptions, packetStreamBaseRef) {
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

    log.info('Starting CoreDeviceProxy...');
    const { socket } = await startCoreDeviceProxy(
      lockdownService,
      lockdownDevice.DeviceID,
      lockdownDevice.Properties.SerialNumber,
      tlsOptions,
    );
    log.info('CoreDeviceProxy started successfully');

    log.info('Creating tunnel...');
    const tunnel = await TunnelManager.getTunnel(socket);
    log.info(
      `Tunnel created for address: ${tunnel.Address} with RsdPort: ${tunnel.RsdPort}`,
    );

    let packetStreamPort;
    try {
      packetStreamPort = packetStreamBaseRef.value++;
      const packetStreamServer = new PacketStreamServer(packetStreamPort);
      await packetStreamServer.start();

      const consumer = packetStreamServer.getPacketConsumer();
      if (consumer) {
        tunnel.addPacketConsumer(consumer);
      }

      packetStreamServers.set(udid, packetStreamServer);

      log.info(`Packet stream server started on port ${packetStreamPort}`);
    } catch (err) {
      log.warn(`Failed to start packet stream server: ${err}`);
    }

    log.info(`✅ Tunnel creation completed successfully for device: ${udid}`);
    log.info(`   Tunnel Address: ${tunnel.Address}`);
    log.info(`   Tunnel RsdPort: ${tunnel.RsdPort}`);
    if (packetStreamPort) {
      log.info(`   Packet Stream Port: ${packetStreamPort}`);
    }

    try {
      if (socket && typeof socket === 'object' && socket.setNoDelay) {
        socket.setNoDelay(true);
      }

      return {
        device,
        tunnel: {
          Address: tunnel.Address,
          RsdPort: tunnel.RsdPort,
        },
        packetStreamPort,
        success: true,
        socket,
      };
    } catch (err) {
      log.warn(`Could not add device to info server: ${err}`);

      return {
        device,
        tunnel: {
          Address: tunnel.Address,
          RsdPort: tunnel.RsdPort,
        },
        packetStreamPort,
        success: true,
        socket,
      };
    }
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
      '--packet-stream-base-port <port>',
      'Base port for packet stream servers (1-65535)',
      parsePort,
    )
    .option(
      '--tunnel-registry-port <port>',
      `Port for tunnel registry API (default: ${DEFAULT_TUNNEL_REGISTRY_PORT})`,
      parsePort,
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

  const tlsOptions = {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
  };

  const packetStreamBaseRef = {
    value: options.packetStreamBasePort ?? 50000,
  };
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

    log.info(`\nProcessing ${devicesToProcess.length} device(s)...`);

    const results = [];

    for (const device of devicesToProcess) {
      const result = await createTunnelForDevice(
        device,
        tlsOptions,
        packetStreamBaseRef,
      );
      results.push(result);

      if (devicesToProcess.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    log.info('\n=== TUNNEL CREATION SUMMARY ===');
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    log.info(`Total devices processed: ${results.length}`);
    log.info(`Successful tunnels: ${successful.length}`);
    log.info(`Failed tunnels: ${failed.length}`);

    if (successful.length > 0) {
      log.info('\n✅ Successful tunnels:');
      const registry = await updateTunnelRegistry(results);
      await startTunnelRegistryServer(registry, registryPort);
      attachTunnelRegistryLifecycleWatch(registry, successful);

      log.info('\n📁 Tunnel registry API:');
      log.info('   The tunnel registry is now available through the API at:');
      log.info(`   http://localhost:${registryPort}/remotexpc/tunnels`);
      log.info('\n   Available endpoints:');
      log.info('   - GET /remotexpc/tunnels - List all tunnels');
      log.info('   - GET /remotexpc/tunnels/:udid - Get tunnel by UDID');
      log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

      log.info('\n💡 Example usage:');
      log.info(
        `   curl http://localhost:${registryPort}/remotexpc/tunnels`,
      );
      log.info(
        `   curl http://localhost:${registryPort}/remotexpc/tunnels/metadata`,
      );
      if (successful.length > 0) {
        const firstUdid = successful[0].device.Properties.SerialNumber;
        log.info(
          `   curl http://localhost:${registryPort}/remotexpc/tunnels/${firstUdid}`,
        );
      }
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
 * @property {{ Properties: { SerialNumber: string } }} device
 * @property {{ Address: string, RsdPort?: number }} tunnel
 * @property {import('tls').TLSSocket} [socket]
 */
