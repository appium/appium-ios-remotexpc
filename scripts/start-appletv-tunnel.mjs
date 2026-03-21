#!/usr/bin/env node
/**
 * Start an Apple TV Remote XPC tunnel and expose the tunnel registry API.
 */

import { logger } from '@appium/support';
import { Command } from 'commander';
import {
  AppleTVTunnelService,
  DEFAULT_TUNNEL_REGISTRY_PORT,
  PacketStreamServer,
  TunnelManager,
  startTunnelRegistryServer,
} from 'appium-ios-remotexpc';

const log = logger.getLogger('WiFiTunnel');
const PACKET_STREAM_PORT = 50100;

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid port: ${value}. Expected an integer between 1 and 65535.`,
    );
  }
  return port;
}

async function main() {
  const program = new Command();
  program
    .name('start-appletv-tunnel')
    .description('Start an Apple TV WiFi tunnel and tunnel registry HTTP API')
    .argument(
      '[deviceIdentifier]',
      'Optional Apple TV device identifier to target',
    )
    .option(
      '--tunnel-registry-port <port>',
      `Port for tunnel registry API (default: ${DEFAULT_TUNNEL_REGISTRY_PORT})`,
      parsePort,
    );

  program.parse(process.argv);
  const options = program.opts();
  const deviceIdentifier = program.args[0];
  const registryPort =
    options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;

  if (deviceIdentifier) {
    log.info(
      `Starting Apple TV tunnel for specific device identifier: ${deviceIdentifier}`,
    );
  } else {
    log.info('Starting Apple TV tunnel (will try all discovered devices)');
  }

  const tunnelService = new AppleTVTunnelService();
  let tunnel = null;
  let tlsSocket = null;
  let deviceInfo = null;
  let packetStreamServer = null;

  const cleanup = async (signal) => {
    log.warn(`\nCleaning up (${signal})...`);

    try {
      if (packetStreamServer) {
        log.info('Closing packet stream server...');
        await packetStreamServer.stop();
        packetStreamServer = null;
      }

      if (tunnel && typeof tunnel.closer === 'function') {
        log.info('Closing tunnel...');
        await tunnel.closer();
      }

      if (tlsSocket && !tlsSocket.destroyed) {
        log.info('Closing TLS-PSK connection...');
        tlsSocket.destroy();
      }

      tunnelService.disconnect();

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

  try {
    log.info('Starting Apple TV tunnel...');
    const result = await tunnelService.startTunnel(
      undefined,
      deviceIdentifier,
    );
    tlsSocket = result.socket;
    deviceInfo = result.device;

    if (!tlsSocket) {
      throw new Error('TLS-PSK socket not established');
    }

    log.info('Creating tunnel with TunnelManager...');
    tunnel = await TunnelManager.getTunnel(tlsSocket);

    let packetStreamPort = 0;
    try {
      packetStreamServer = new PacketStreamServer(PACKET_STREAM_PORT);
      await packetStreamServer.start();

      const consumer = packetStreamServer.getPacketConsumer();
      if (consumer && tunnel.addPacketConsumer) {
        tunnel.addPacketConsumer(consumer);
        log.info(`Packet stream server started on port ${PACKET_STREAM_PORT}`);
        packetStreamPort = PACKET_STREAM_PORT;
      } else {
        log.warn('Failed to attach packet consumer to tunnel');
      }
    } catch (err) {
      log.warn(`Failed to start packet stream server: ${err}`);
    }

    const now = Date.now();
    const nowISOString = new Date().toISOString();

    const registry = {
      tunnels: {
        [deviceInfo.identifier]: {
          udid: deviceInfo.identifier,
          deviceId: 0,
          address: tunnel.Address,
          rsdPort: tunnel.RsdPort ?? 0,
          packetStreamPort,
          connectionType: 'WiFi',
          productId: 0,
          createdAt: now,
          lastUpdated: now,
        },
      },
      metadata: {
        lastUpdated: nowISOString,
        totalTunnels: 1,
        activeTunnels: 1,
      },
    };

    await startTunnelRegistryServer(registry, registryPort);

    log.info('=== TUNNEL ESTABLISHED ===');
    log.info(`Tunnel Address: ${tunnel.Address}`);
    log.info(`Tunnel RSD Port: ${tunnel.RsdPort}`);
    log.info(`Packet Stream Port: ${packetStreamPort}`);
    log.info('==========================');

    log.info('\n📁 Tunnel registry API:');
    log.info(
      `   http://localhost:${registryPort}/remotexpc/tunnels`,
    );
    log.info('   - GET /remotexpc/tunnels - List all tunnels');
    log.info(
      `   - GET /remotexpc/tunnels/${deviceInfo.identifier} - Get tunnel by identifier`,
    );

    log.info('\n✅ Apple TV tunnel is ready!');
    log.info(`Use: --rsd ${tunnel.Address} ${tunnel.RsdPort}`);
    log.info('\nPress Ctrl+C to close the tunnel and exit.');

    process.stdin.resume();
  } catch (error) {
    log.error('Tunnel failed:', error);
    throw error;
  }
}

await main();
