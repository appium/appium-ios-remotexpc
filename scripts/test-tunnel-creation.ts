#!/usr/bin/env node
/**
 * Test script for creating lockdown service, starting CoreDeviceProxy, and creating tunnel
 * This script demonstrates the tunnel creation workflow for all connected devices
 */
import { logger } from '@appium/support';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ConnectionOptions } from 'tls';

import {
  TunnelManager,
  createLockdownServiceByUDID,
  createUsbmux,
  startCoreDeviceProxy,
} from '../src/index.js';
import type { Device } from '../src/lib/usbmux/index.js';

const log = logger.getLogger('TunnelCreationTest');

// Path to the tunnel registry file
const TUNNEL_REGISTRY_PATH = join(process.cwd(), 'tunnel-registry.json');

/**
 * Load existing tunnel registry from file
 */
async function loadTunnelRegistry(): Promise<TunnelRegistry> {
  try {
    const data = await fs.readFile(TUNNEL_REGISTRY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // Return empty registry if file doesn't exist or is invalid
    return {
      tunnels: {},
      metadata: {
        lastUpdated: new Date().toISOString(),
        totalTunnels: 0,
        activeTunnels: 0,
      },
    };
  }
}

/**
 * Save tunnel registry to file
 */
async function saveTunnelRegistry(registry: TunnelRegistry): Promise<void> {
  try {
    await fs.writeFile(TUNNEL_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
    log.info(`Tunnel registry saved to: ${TUNNEL_REGISTRY_PATH}`);
  } catch (error) {
    log.error(`Failed to save tunnel registry: ${error}`);
    throw error;
  }
}

/**
 * Update tunnel registry with new tunnel information
 */
async function updateTunnelRegistry(results: TunnelResult[]): Promise<void> {
  const registry = await loadTunnelRegistry();
  const now = new Date().toISOString();

  // Update tunnels
  for (const result of results) {
    if (result.success) {
      const udid = result.device.Properties.SerialNumber;
      registry.tunnels[udid] = {
        udid,
        deviceId: result.device.DeviceID,
        address: result.tunnel.Address,
        rsdPort: result.tunnel.RsdPort ?? 0,
        connectionType: result.device.Properties.ConnectionType,
        productId: result.device.Properties.ProductID,
        createdAt: registry.tunnels[udid]?.createdAt ?? now,
        lastUpdated: now,
      };
    }
  }

  // Update metadata
  registry.metadata = {
    lastUpdated: now,
    totalTunnels: Object.keys(registry.tunnels).length,
    activeTunnels: Object.keys(registry.tunnels).length, // Assuming all are active for now
  };

  await saveTunnelRegistry(registry);
}

/**
 * Clear tunnel registry (remove file or set empty state)
 */
async function clearTunnelRegistry(): Promise<void> {
  try {
    const emptyRegistry: TunnelRegistry = {
      tunnels: {},
      metadata: {
        lastUpdated: new Date().toISOString(),
        totalTunnels: 0,
        activeTunnels: 0,
      },
    };

    await saveTunnelRegistry(emptyRegistry);
    log.info('Tunnel registry cleared due to process interruption');
  } catch (error) {
    log.error(`Failed to clear tunnel registry: ${error}`);
    // Try to delete the file as fallback
    try {
      await fs.unlink(TUNNEL_REGISTRY_PATH);
      log.info('Tunnel registry file deleted as fallback cleanup');
    } catch (deleteError) {
      log.error(`Failed to delete tunnel registry file: ${deleteError}`);
    }
  }
}

/**
 * Setup cleanup handlers for graceful shutdown
 */
function setupCleanupHandlers(): void {
  const cleanup = async (signal: string) => {
    log.warn(`\nReceived ${signal}. Cleaning up tunnel registry...`);
    await clearTunnelRegistry();
    log.info('Cleanup completed. Exiting...');
    process.exit(0);
  };

  // Handle various termination signals
  process.on('SIGINT', () => cleanup('SIGINT (Ctrl+C)'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));

  // Handle uncaught exceptions and unhandled rejections
  process.on('uncaughtException', async (error) => {
    log.error('Uncaught Exception:', error);
    await clearTunnelRegistry();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await clearTunnelRegistry();
    process.exit(1);
  });
}

/**
 * Interface for tunnel result
 */
interface TunnelResult {
  device: Device;
  tunnel: {
    Address: string;
    RsdPort?: number;
  };
  success: boolean;
  error?: string;
}

/**
 * Interface for tunnel registry entry
 */
interface TunnelRegistryEntry {
  udid: string;
  deviceId: number;
  address: string;
  rsdPort: number;
  connectionType: string;
  productId: number;
  createdAt: string;
  lastUpdated: string;
}

/**
 * Interface for tunnel registry
 */
interface TunnelRegistry {
  tunnels: Record<string, TunnelRegistryEntry>;
  metadata: {
    lastUpdated: string;
    totalTunnels: number;
    activeTunnels: number;
  };
}

/**
 * Create tunnel for a single device
 */
async function createTunnelForDevice(
  device: Device,
  tlsOptions: Partial<ConnectionOptions>,
): Promise<TunnelResult> {
  const udid = device.Properties.SerialNumber;

  try {
    log.info(`\n--- Processing device: ${udid} ---`);
    log.info(`Device ID: ${device.DeviceID}`);
    log.info(`Connection Type: ${device.Properties.ConnectionType}`);
    log.info(`Product ID: ${device.Properties.ProductID}`);

    // Create lockdown service
    log.info('Creating lockdown service...');
    const { lockdownService, device: lockdownDevice } =
      await createLockdownServiceByUDID(udid);
    log.info(
      `Lockdown service created for device: ${lockdownDevice.Properties.SerialNumber}`,
    );

    // Start CoreDeviceProxy
    log.info('Starting CoreDeviceProxy...');
    const { socket } = await startCoreDeviceProxy(
      lockdownService,
      lockdownDevice.DeviceID,
      lockdownDevice.Properties.SerialNumber,
      tlsOptions,
    );
    log.info('CoreDeviceProxy started successfully');

    // Create a new tunnel
    log.info('Creating tunnel...');
    const tunnel = await TunnelManager.getTunnel(socket);
    log.info(
      `Tunnel created for address: ${tunnel.Address} with RsdPort: ${tunnel.RsdPort}`,
    );

    log.info(`✅ Tunnel creation completed successfully for device: ${udid}`);
    log.info(`   Tunnel Address: ${tunnel.Address}`);
    log.info(`   Tunnel RsdPort: ${tunnel.RsdPort}`);

    return {
      device,
      tunnel: {
        Address: tunnel.Address,
        RsdPort: tunnel.RsdPort,
      },
      success: true,
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

/**
 * Main function to test tunnel creation workflow for all devices
 */
async function main(): Promise<void> {
  // Setup cleanup handlers first
  setupCleanupHandlers();

  // Check if a specific UDID is provided
  const specificUdid = process.argv[2];

  if (specificUdid) {
    log.info(
      `Starting tunnel creation test for specific UDID: ${specificUdid}`,
    );
  } else {
    log.info('Starting tunnel creation test for all connected devices');
  }

  try {
    // TLS options for the connection (can be customized as needed)
    const tlsOptions: Partial<ConnectionOptions> = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    };

    // Create usbmux instance to list devices
    log.info('Connecting to usbmuxd...');
    const usbmux = await createUsbmux();

    // List all connected devices
    log.info('Listing all connected devices...');
    const devices = await usbmux.listDevices();

    // Close the usbmux connection as we don't need it anymore
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

    // Filter devices if specific UDID is provided
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

    // Process each device and create tunnels
    const results: TunnelResult[] = [];

    for (const device of devicesToProcess) {
      const result = await createTunnelForDevice(device, tlsOptions);
      results.push(result);

      // Add a small delay between devices to avoid overwhelming the system
      if (devicesToProcess.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Summary
    log.info('\n=== TUNNEL CREATION SUMMARY ===');
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    log.info(`Total devices processed: ${results.length}`);
    log.info(`Successful tunnels: ${successful.length}`);
    log.info(`Failed tunnels: ${failed.length}`);

    if (successful.length > 0) {
      log.info('\n✅ Successful tunnels:');
      successful.forEach((result, index) => {
        const udid = result.device.Properties.SerialNumber;

        log.info(
          `  ${index + 1}. Device: ${udid}`,
        );
        log.info(`     Address: ${result.tunnel.Address}`);
        log.info(`     RSD Port: ${result.tunnel.RsdPort}`);
        log.info(`     Connection Type: ${result.device.Properties.ConnectionType}`);
        log.info(`     Product ID: ${result.device.Properties.ProductID}`);
      });

      // Update the tunnel registry file
      await updateTunnelRegistry(results);

      log.info('\n📁 Tunnel registry updated:');
      log.info(`   Registry file: ${TUNNEL_REGISTRY_PATH}`);
      log.info('   This file contains persistent tunnel information that can be');
      log.info('   accessed by other Appium processes at any time.');

      // Show how to access the data
      log.info('\n💡 How to access tunnel data from other processes:');
      log.info('   1. Read the tunnel-registry.json file');
      log.info('   2. Parse the JSON to get tunnel information for any device');
      log.info('   3. Use the UDID as the key to find specific device tunnels');

      // Set minimal environment variables for backward compatibility
      const firstSuccess = successful[0];
      process.env.TUNNEL_ADDRESS = firstSuccess.tunnel.Address;
      process.env.TUNNEL_RSD_PORT =
        firstSuccess.tunnel.RsdPort?.toString() ?? '0';
      process.env.TUNNEL_UDID = firstSuccess.device.Properties.SerialNumber;
      process.env.TUNNEL_REGISTRY_PATH = TUNNEL_REGISTRY_PATH;

      log.info('\n🔄 Backward compatibility environment variables (first device only):');
      log.info(`   TUNNEL_ADDRESS=${process.env.TUNNEL_ADDRESS}`);
      log.info(`   TUNNEL_RSD_PORT=${process.env.TUNNEL_RSD_PORT}`);
      log.info(`   TUNNEL_UDID=${process.env.TUNNEL_UDID}`);
      log.info(`   TUNNEL_REGISTRY_PATH=${process.env.TUNNEL_REGISTRY_PATH}`);
    }

    if (failed.length > 0) {
      log.info('\n❌ Failed tunnels:');
      failed.forEach((result, index) => {
        log.info(
          `  ${index + 1}. Device: ${result.device.Properties.SerialNumber}`,
        );
        log.info(`     Error: ${result.error}`);
      });
    }

    if (failed.length === results.length) {
      log.error('\nAll tunnel creation attempts failed!');
      process.exit(1);
    } else {
      log.info('\nTunnel creation process completed!');
    }
  } catch (error) {
    log.error(`Error during tunnel creation test: ${error}`);
    process.exit(1);
  }
}

// Run the main function
main().catch(async (error) => {
  log.error(`Fatal error: ${error}`);
  await clearTunnelRegistry();
  process.exit(1);
});
