#!/usr/bin/env node
/**
 * Script to start the Tunnel Registry Server
 * This server provides API endpoints for tunnel registry operations
 */
import { logger } from '@appium/support';

import { startTunnelRegistryServer } from '../src/index.js';

const log = logger.getLogger('TunnelRegistryServer');

/**
 * Main function to start the tunnel registry server
 */
async function main(): Promise<void> {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const portArg = args.find((arg) => arg.startsWith('--port='));
    const registryPathArg = args.find((arg) =>
      arg.startsWith('--registry-path='),
    );

    // Extract port from arguments
    let port: number | undefined;
    if (portArg) {
      const portValue = portArg.split('=')[1];
      port = parseInt(portValue, 10);
      if (isNaN(port)) {
        log.error(`Invalid port: ${portValue}`);
        process.exit(1);
      }
    }

    // Extract registry path from arguments
    let registryPath: string | undefined;
    if (registryPathArg) {
      registryPath = registryPathArg.split('=')[1];
    }

    // Start the server
    log.info('Starting Tunnel Registry Server...');
    if (port) {
      log.info(`Using custom port: ${port}`);
    }
    if (registryPath) {
      log.info(`Using custom registry path: ${registryPath}`);
    }

    await startTunnelRegistryServer(port, registryPath);

    log.info('Tunnel Registry Server started successfully');
    log.info('Press Ctrl+C to stop the server');

    // Keep the process running
    process.on('SIGINT', async () => {
      log.info('Received SIGINT. Shutting down...');
      process.exit(0);
    });
  } catch (error) {
    log.error(`Error starting Tunnel Registry Server: ${error}`);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
