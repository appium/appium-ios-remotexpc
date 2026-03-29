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
  PacketStreamServer,
  TunnelManager,
  startTunnelRegistryServer,
  watchTunnelRegistrySockets,
} from 'appium-ios-remotexpc';
import { DEFAULT_TUNNEL_REGISTRY_PORT } from '../build/src/lib/tunnel/tunnel-registry-server.js';

const log = logger.getLogger('WiFiTunnel');

const packetStreamServers = new Map();
/** @type {{ stop: (() => void) | null }} */
const registryWatcherRef = { stop: null };
/** @type {Array<{ tunnel: object; tlsSocket: import('tls').TLSSocket; device: { identifier: string; name?: string } }>} */
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

/**
 * @param {object} registry
 * @param {AppleTvEstablishedTunnel[]} successfulResults
 */
function attachAppleTvTunnelRegistryLifecycleWatch(registry, successfulResults) {
  const watches = successfulResults
    .filter((r) => r.tlsSocket)
    .map((r) => ({
      udid: r.device.identifier,
      socket: r.tlsSocket,
      rsdProbe: {
        host: r.tunnel.Address,
        port: r.tunnel.RsdPort ?? 0,
      },
    }));

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

    try {
      if (typeof registryWatcherRef.stop === 'function') {
        registryWatcherRef.stop();
        registryWatcherRef.stop = null;
      }

      if (packetStreamServers.size > 0) {
        for (const [udid, server] of packetStreamServers) {
          try {
            await server.stop();
            log.info(`Closed packet stream server for ${udid}`);
          } catch (err) {
            log.warn(`Failed to close packet stream server for ${udid}: ${err}`);
          }
        }
        packetStreamServers.clear();
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
 * @param {{ value: number }} packetStreamBaseRef
 * @returns {Promise<AppleTvEstablishedTunnel>}
 */
async function establishOneTunnel(startResult, packetStreamBaseRef) {
  const tlsSocket = startResult.socket;
  const device = startResult.device;

  log.info('Creating tunnel with TunnelManager...');
  const tunnel = await TunnelManager.getTunnel(tlsSocket);

  let packetStreamPort = 0;
  try {
    packetStreamPort = packetStreamBaseRef.value++;
    const pss = new PacketStreamServer(packetStreamPort);
    await pss.start();

    const consumer = pss.getPacketConsumer();
    if (consumer && tunnel.addPacketConsumer) {
      tunnel.addPacketConsumer(consumer);
      log.info(
        `Packet stream server for ${device.identifier} on port ${packetStreamPort}`,
      );
    } else {
      log.warn(`Failed to attach packet consumer for ${device.identifier}`);
    }
    packetStreamServers.set(device.identifier, pss);
  } catch (err) {
    log.warn(`Failed to start packet stream server for ${device.identifier}: ${err}`);
  }

  establishedTunnels.push({ tunnel, tlsSocket, device });

  return {
    device,
    tunnel,
    tlsSocket,
    packetStreamPort,
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
      '--packet-stream-base-port <port>',
      'Base port for packet stream servers (incremented per device; default: 50100)',
      parsePort,
    );

  program.parse(process.argv);
  const options = program.opts();
  const deviceIdentifier = program.args[0];
  const registryPort =
    options.tunnelRegistryPort ?? DEFAULT_TUNNEL_REGISTRY_PORT;
  const packetStreamBaseRef = {
    value: options.packetStreamBasePort ?? 50100,
  };

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
      successfulResults.push(await establishOneTunnel(result, packetStreamBaseRef));
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
            await establishOneTunnel(result, packetStreamBaseRef),
          );
          log.info(`Tunnel established for ${d.identifier}`);
        } catch (err) {
          log.warn(`Skipping ${d.identifier}: ${err}`);
        }
        if (i < devices.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    if (successfulResults.length === 0) {
      throw new Error('No tunnel could be established');
    }

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

    for (const r of successfulResults) {
      registry.tunnels[r.device.identifier] = {
        udid: r.device.identifier,
        deviceId: 0,
        address: r.tunnel.Address,
        rsdPort: r.tunnel.RsdPort ?? 0,
        packetStreamPort: r.packetStreamPort,
        connectionType: 'WiFi',
        productId: 0,
        createdAt: now,
        lastUpdated: now,
      };
    }

    registry.metadata = {
      lastUpdated: nowISOString,
      totalTunnels: Object.keys(registry.tunnels).length,
      activeTunnels: Object.keys(registry.tunnels).length,
    };

    await startTunnelRegistryServer(registry, registryPort);
    attachAppleTvTunnelRegistryLifecycleWatch(registry, successfulResults);

    log.info(
      `\n=== ${util.pluralize('tunnel', successfulResults.length, true).toUpperCase()} ESTABLISHED ===`,
    );
    for (const r of successfulResults) {
      log.info(
        `${r.device.identifier}: ${r.tunnel.Address}:${r.tunnel.RsdPort ?? 0} (packet stream ${r.packetStreamPort || 'off'})`,
      );
    }
    log.info('=============================');

    log.info('\n📁 Tunnel registry API:');
    log.info(
      `   http://localhost:${registryPort}/remotexpc/tunnels`,
    );
    log.info('   - GET /remotexpc/tunnels - List all tunnels');
    for (const r of successfulResults) {
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
 * One fully established Apple TV tunnel (Remote XPC + optional packet stream port).
 *
 * @typedef {object} AppleTvEstablishedTunnel
 * @property {{ identifier: string, name?: string }} device
 * @property {{ Address: string, RsdPort?: number }} tunnel
 * @property {import('tls').TLSSocket} tlsSocket
 * @property {number} packetStreamPort
 */
