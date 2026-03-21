#!/usr/bin/env node
/**
 * Wi‑Fi Remote Pairing tunnel + registry. Requires `npm run build`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { PacketStreamServer, TunnelManager } from '../build/src/index.js';
import { RemotePairingTunnelService } from '../build/src/lib/remote-pairing/tunnel/index.js';
import { getLogger } from '../build/src/lib/logger.js';
import {
  DEFAULT_TUNNEL_REGISTRY_PORT,
  startTunnelRegistryServer,
} from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = getLogger('WiFiTunnel');
const PACKET_STREAM_PORT = 50100;

async function main() {
  const program = new Command();
  program
    .name('start-appletv-tunnel')
    .description(
      'Start a Wi‑Fi Remote Pairing tunnel and expose the tunnel registry API',
    )
    .argument(
      '[deviceIdentifier]',
      'Optional device identifier (omit to try all discovered devices)',
    );

  program.parse(process.argv);
  const deviceIdentifier = program.args[0];

  if (deviceIdentifier) {
    log.info(
      `Starting Wi‑Fi tunnel for specific device identifier: ${deviceIdentifier}`,
    );
  } else {
    log.info('Starting Wi‑Fi tunnel (will try all discovered devices)');
  }

  const tunnelService = new RemotePairingTunnelService();
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
    log.info('Starting Remote Pairing tunnel...');
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

    await startTunnelRegistryServer(registry);

    log.info('=== TUNNEL ESTABLISHED ===');
    log.info(`Tunnel Address: ${tunnel.Address}`);
    log.info(`Tunnel RSD Port: ${tunnel.RsdPort}`);
    log.info(`Packet Stream Port: ${packetStreamPort}`);
    log.info('==========================');

    log.info('\n📁 Tunnel registry API:');
    log.info(
      `   http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels`,
    );
    log.info('   - GET /remotexpc/tunnels - List all tunnels');
    log.info(
      `   - GET /remotexpc/tunnels/${deviceInfo.identifier} - Get tunnel by identifier`,
    );

    log.info('\n✅ Wi‑Fi tunnel is ready!');
    log.info(`Use: --rsd ${tunnel.Address} ${tunnel.RsdPort}`);
    log.info('\nPress Ctrl+C to close the tunnel and exit.');

    process.stdin.resume();
  } catch (error) {
    log.error('Tunnel failed:', error);
    throw error;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  try {
    await main();
  } catch (err) {
    log.error(err);
    process.exit(1);
  }
}
