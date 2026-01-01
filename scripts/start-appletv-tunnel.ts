#!/usr/bin/env tsx
import * as tls from 'node:tls';

import { PacketStreamServer, TunnelManager } from '../src/index.js';
import type { TunnelRegistry } from '../src/index.js';
import { AppleTVTunnelService } from '../src/lib/apple-tv/tunnel/index.js';
import type { AppleTVDevice } from '../src/lib/bonjour/bonjour-discovery.js';
import { getLogger } from '../src/lib/logger.js';
import type { TunnelConnection } from '../src/lib/tunnel/index.js';
import {
  DEFAULT_TUNNEL_REGISTRY_PORT,
  startTunnelRegistryServer,
} from '../src/lib/tunnel/tunnel-registry-server.js';

const log = getLogger('WiFiTunnel');
const PACKET_STREAM_PORT = 50100;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const specificDeviceIdentifier = args.find((arg) => !arg.startsWith('-'));

  if (specificDeviceIdentifier) {
    log.info(
      `Starting Apple TV tunnel for specific device identifier: ${specificDeviceIdentifier}`,
    );
  } else {
    log.info('Starting Apple TV tunnel (will try all discovered devices)');
  }

  const tunnelService = new AppleTVTunnelService();
  let tunnel: TunnelConnection | null = null;
  let tlsSocket: tls.TLSSocket | null = null;
  let deviceInfo: AppleTVDevice | null = null;
  let packetStreamServer: PacketStreamServer | null = null;

  const cleanup = async (signal: string): Promise<void> => {
    log.warn(`\nCleaning up (${signal})...`);

    try {
      // Close packet stream server first
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
      specificDeviceIdentifier,
    );
    tlsSocket = result.socket;
    deviceInfo = result.device;

    if (!tlsSocket) {
      throw new Error('TLS-PSK socket not established');
    }

    log.info('Creating tunnel with TunnelManager...');
    tunnel = await TunnelManager.getTunnel(tlsSocket);

    // Start packet stream server (same as iPhone tunnel)
    let packetStreamPort = 0;
    try {
      packetStreamServer = new PacketStreamServer(PACKET_STREAM_PORT);
      await packetStreamServer.start();

      // Attach packet consumer to tunnel to receive packet data
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

    const registry: TunnelRegistry = {
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
    log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

    log.info('\n✅ Apple TV tunnel is ready!');
    log.info(`Use: --rsd ${tunnel.Address} ${tunnel.RsdPort}`);
    log.info('\nPress Ctrl+C to close the tunnel and exit.');

    process.stdin.resume();
  } catch (error) {
    log.error('Tunnel failed:', error);
    throw error;
  } finally {
    await cleanup('Shutdown');
  }
}

main();
