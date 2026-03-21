#!/usr/bin/env node
/**
 * Test script: lockdown, CoreDeviceProxy, tunnel. Requires `npm run build`.
 */
import { logger } from '@appium/support';
import { Command } from 'commander';

import {
  PacketStreamServer,
  TunnelManager,
  createLockdownServiceByUDID,
  createUsbmux,
  startCoreDeviceProxy,
} from '../build/src/index.js';
import {
  DEFAULT_TUNNEL_REGISTRY_PORT,
  startTunnelRegistryServer,
} from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('TunnelCreation');

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
      registry.tunnels[udid] = {
        udid,
        deviceId: result.device.DeviceID,
        address: result.tunnel.Address,
        rsdPort: result.tunnel.RsdPort ?? 0,
        packetStreamPort: result.packetStreamPort ?? 0,
        connectionType: result.device.Properties.ConnectionType,
        productId: result.device.Properties.ProductID,
        createdAt: registry.tunnels[udid]?.createdAt ?? now,
        lastUpdated: now,
      };
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

let PACKET_STREAM_BASE_PORT = 50000;

function setupCleanupHandlers() {
  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

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

async function createTunnelForDevice(device, tlsOptions) {
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
      packetStreamPort = PACKET_STREAM_BASE_PORT++;
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
    .name('test-tunnel-creation')
    .description(
      'Create lockdown tunnels via USB (CoreDeviceProxy) for connected devices',
    )
    .argument('[udid]', 'Specific device UDID')
    .option('-k, --keep-open', 'Keep connections open for lsof inspection')
    .option('--udid <udid>', 'Specific device UDID (overrides positional [udid])');

  program.parse(process.argv);
  const options = program.opts();
  const keepOpenFlag = Boolean(options.keepOpen);
  const specificUdid = options.udid ?? program.args[0];

  if (specificUdid) {
    log.info(
      `Starting tunnel creation test for specific UDID: ${specificUdid}`,
    );
  } else {
    log.info('Starting tunnel creation test for all connected devices');
  }

  if (keepOpenFlag) {
    log.info('Running in "keep connections open" mode for lsof inspection');
  }

  try {
    const tlsOptions = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    };

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
      const result = await createTunnelForDevice(device, tlsOptions);
      results.push(result);

      if (devicesToProcess.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    log.info('\n=== TUNNEL CREATION SUMMARY ===');
    const successful = results.filter((r) => r.success);

    log.info(`Total devices processed: ${results.length}`);
    log.info(`Successful tunnels: ${successful.length}`);
    log.info(`Failed tunnels: ${results.length - successful.length}`);

    if (successful.length > 0) {
      log.info('\n✅ Successful tunnels:');
      const registry = await updateTunnelRegistry(results);
      await startTunnelRegistryServer(registry);

      log.info('\n📁 Tunnel registry API:');
      log.info('   The tunnel registry is now available through the API at:');
      log.info(
        `   http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels`,
      );
      log.info('\n   Available endpoints:');
      log.info('   - GET /remotexpc/tunnels - List all tunnels');
      log.info('   - GET /remotexpc/tunnels/:udid - Get tunnel by UDID');
      log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

      log.info('\n💡 Example usage:');
      log.info(
        `   curl http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels`,
      );
      log.info(
        `   curl http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels/metadata`,
      );
      if (successful.length > 0) {
        const firstUdid = successful[0].device.Properties.SerialNumber;
        log.info(
          `   curl http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels/${firstUdid}`,
        );
      }
    }
  } catch (error) {
    log.error(`Error during tunnel creation test: ${error}`);
    throw error;
  }
}

try {
  await main();
} catch (err) {
  log.error(err);
  process.exit(1);
}
