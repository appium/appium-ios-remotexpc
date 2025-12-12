#!/usr/bin/env tsx
import { getLogger } from '../src/lib/logger.js';
import { lookup } from 'node:dns/promises';
import * as tls from 'node:tls';

import { DEFAULT_PAIRING_CONFIG } from '../src/lib/apple-tv/constants.js';
import { NetworkClient } from '../src/lib/apple-tv/network/index.js';
import {
  PairVerificationProtocol,
  type VerificationKeys,
} from '../src/lib/apple-tv/pairing-protocol/index.js';
import { PairingStorage } from '../src/lib/apple-tv/storage/pairing-storage.js';
import type { PairRecord } from '../src/lib/apple-tv/storage/types.js';
import { TunnelService } from '../src/lib/apple-tv/tunnel/tunnel-service.js';
import { BonjourDiscovery, type AppleTVDevice } from '../src/lib/bonjour/bonjour-discovery.js';
import { TunnelManager, PacketStreamServer, type TunnelConnection } from '../src/index.js';
import type { TunnelRegistry } from '../src/index.js';
import { startTunnelRegistryServer, DEFAULT_TUNNEL_REGISTRY_PORT } from '../src/lib/tunnel/tunnel-registry-server.js';

const log = getLogger('WiFiTunnel');
const PACKET_STREAM_PORT = 50100;

class AppleTVTunnelService {
  private logger = getLogger('AppleTVTunnelService');
  private networkClient: NetworkClient;
  private storage: PairingStorage;
  private sequenceNumber = 0;

  constructor() {
    this.networkClient = new NetworkClient(DEFAULT_PAIRING_CONFIG);
    this.storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
  }

  disconnect(): void {
    this.networkClient.disconnect();
  }

  async startTunnel(deviceId?: string, specificDeviceIdentifier?: string): Promise<{ socket: tls.TLSSocket; device: AppleTVDevice }> {
    const devices = await this.discoverDevices();

    this.logger.debug('Step 1: Device Discovery success');
    this.logger.debug(`Found ${devices.length} device(s) via Bonjour`);

    // List all discovered devices
    if (devices.length > 0) {
      this.logger.info('\nDiscovered Apple TV devices:');
      devices.forEach((device, index) => {
        this.logger.info(`  ${index + 1}. Identifier: ${device.identifier}`);
        this.logger.info(`     Name: ${device.name}`);
        this.logger.info(`     IP: ${device.ip}:${device.port}`);
        this.logger.info(`     Model: ${device.model}`);
        this.logger.info(`     Version: ${device.version}`);
      });
    }

    // Filter devices by identifier if specified
    let devicesToProcess = devices;
    if (specificDeviceIdentifier) {
      devicesToProcess = devices.filter(
        (device) => device.identifier === specificDeviceIdentifier
      );

      if (devicesToProcess.length === 0) {
        this.logger.error(`\nDevice with identifier ${specificDeviceIdentifier} not found in discovered devices.`);
        this.logger.error('Available devices:');
        devices.forEach((device) => {
          this.logger.error(`  - ${device.identifier} (${device.name})`);
        });
        throw new Error(
          `Device with identifier ${specificDeviceIdentifier} not found. Please check available devices above.`
        );
      }

      this.logger.info(`\nFiltered to specific device: ${specificDeviceIdentifier}`);
    }

    const availableDeviceIds = await this.storage.getAvailableDeviceIds();
    if (availableDeviceIds.length === 0) {
      throw new Error('No pair records found');
    }

    if (deviceId && !availableDeviceIds.includes(deviceId)) {
      throw new Error(`No pair record found for specified device ${deviceId}`);
    }

    const failedAttempts: { identifier: string; error: string }[] = [];

    for (const device of devicesToProcess) {
      const identifiersToTry = deviceId ? [deviceId] : availableDeviceIds;

      for (const identifier of identifiersToTry) {
        this.logger.debug(`\n--- Attempting connection with pair record: ${identifier} ---`);
        this.logger.debug(`Device: ${device.ip}:${device.port}`);

        const pairRecord = await this.storage.load(identifier);
        if (!pairRecord) {
          this.logger.debug(`Failed to load pair record for ${identifier}`);
          failedAttempts.push({ identifier, error: 'Failed to load pair record' });
          continue;
        }

        try {
          this.sequenceNumber = 0;
          await this.networkClient.connect(device.ip!, device.port);

          try {
            await this.performHandshake();

            const keys = await this.performPairVerification(pairRecord, identifier);
            this.logger.info(`✅ Successfully verified with pair record: ${identifier}`);

            const listenerInfo = await this.createTcpListener(keys);
            this.networkClient.disconnect();

            const tlsSocket = await this.createTlsPskConnection(device.ip!, listenerInfo.port, keys);

            this.logger.debug('Step 6: Tunnel Establishment success');
            this.logger.info(`🔑 Using pair record: ${identifier}`);
            this.logger.info(`📱 Connected to device: ${device.identifier} (${device.name})`);
            this.logger.info(`   IP: ${device.ip}:${device.port}`);

            return { socket: tlsSocket, device };
          } catch (error: any) {
            const errorMessage = error.message || String(error);
            this.logger.debug(`❌ Failed with pair record ${identifier}: ${errorMessage}`);
            failedAttempts.push({ identifier, error: errorMessage });
            this.networkClient.disconnect();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (connectionError: any) {
          const errorMessage = connectionError.message || String(connectionError);
          this.logger.debug(`Failed to connect to ${device.ip}:${device.port}: ${errorMessage}`);
          failedAttempts.push({ identifier, error: `Connection failed: ${errorMessage}` });
          this.networkClient.disconnect();
        }
      }
    }

    this.logger.error('\n=== Pair Record Verification Summary ===');
    this.logger.error(`Total pair records tried: ${failedAttempts.length}`);
    failedAttempts.forEach(({ identifier, error }) => {
      this.logger.error(`  - ${identifier}: ${error}`);
    });
    this.logger.error('=======================================\n');

    throw new Error(
      'Failed to establish tunnel with any pair record. All authentication attempts failed.',
    );
  }

  private async discoverDevices(): Promise<AppleTVDevice[]> {
    const discovery = new BonjourDiscovery();

    await discovery.startBrowsing('_remotepairing._tcp', 'local');
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_PAIRING_CONFIG.discoveryTimeout));

    const services = discovery.getDiscoveredServices();
    const devices: AppleTVDevice[] = [];

    for (const service of services) {
      try {
        const resolved = await discovery.resolveService(
          service.name,
          '_remotepairing._tcp',
          'local',
        );

        if (resolved.hostname && resolved.port) {
          const ipResult = await lookup(
            resolved.hostname.endsWith('.') ? resolved.hostname.slice(0, -1) : resolved.hostname,
            { family: 4 },
          );

          devices.push({
            name: resolved.name,
            identifier: resolved.txtRecord?.identifier || resolved.name,
            hostname: resolved.hostname,
            ip: ipResult.address,
            port: resolved.port,
            model: resolved.txtRecord?.model || '',
            version: resolved.txtRecord?.ver || '',
            minVersion: resolved.txtRecord?.minVer || '17',
          });
        }
      } catch (err) {
        this.logger.debug(`Failed to resolve service ${service.name}: ${err}`);
      }
    }

    discovery.stopBrowsing();

    if (devices.length === 0) {
      throw new Error('No devices found via Bonjour discovery');
    }

    return devices;
  }

  private async performHandshake(): Promise<void> {
    const handshakePayload = {
      message: {
        plain: {
          _0: {
            request: {
              _0: {
                handshake: {
                  _0: {
                    hostOptions: { attemptPairVerify: true },
                    wireProtocolVersion: 19,
                  },
                },
              },
            },
          },
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };

    await this.networkClient.sendPacket(handshakePayload);
    await this.networkClient.receiveResponse();

    this.logger.debug('Step 2: Initial Connection & Handshake success');
  }

  private async performPairVerification(
    pairRecord: PairRecord,
    deviceId: string,
  ): Promise<VerificationKeys> {
    this.logger.debug('Step 3: Pair Verification (4-step process)');

    const verificationProtocol = new PairVerificationProtocol(
      this.networkClient,
      this.sequenceNumber,
    );
    const keys = await verificationProtocol.verify(pairRecord, deviceId);

    this.sequenceNumber = verificationProtocol.getSequenceNumber();

    this.logger.debug('Step 4: Main Encryption Key Derivation success');

    return keys;
  }

  private async createTcpListener(
    keys: VerificationKeys,
  ): Promise<{ port: number; serviceName: string; devicePublicKey: string }> {
    this.logger.debug('Step 5: TCP Listener Creation (Encrypted Request)');

    const tunnelService = new TunnelService(this.networkClient, keys, this.sequenceNumber);
    const listenerInfo = await tunnelService.createTcpListener();

    this.sequenceNumber = tunnelService.getSequenceNumber();

    return listenerInfo;
  }

  private async createTlsPskConnection(
    hostname: string,
    port: number,
    keys: VerificationKeys,
  ): Promise<tls.TLSSocket> {
    const tunnelService = new TunnelService(this.networkClient, keys, this.sequenceNumber);
    return tunnelService.createTlsPskConnection(hostname, port);
  }
}

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
  let tlsSocket: tls.TLSSocket | undefined;
  let deviceInfo: AppleTVDevice | undefined;
  let packetStreamServer: PacketStreamServer | null = null;

  const cleanup = async (signal: string): Promise<void> => {
    log.warn(`\nReceived ${signal}. Cleaning up...`);

    try {
      // Close packet stream server first
      if (packetStreamServer) {
        log.info('Closing packet stream server...');
        await packetStreamServer.stop();
        packetStreamServer = null;
      }

      if (tunnel && typeof tunnel.close === 'function') {
        log.info('Closing tunnel...');
        await tunnel.close();
      }

      if (tlsSocket && !tlsSocket.destroyed) {
        log.info('Closing TLS-PSK connection...');
        tlsSocket.destroy();
      }

      tunnelService.disconnect();

      log.info('Cleanup completed. Exiting...');
      process.exit(0);
    } catch (err) {
      log.error('Error during cleanup:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => cleanup('SIGINT (Ctrl+C)'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));

  process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
    cleanup('Uncaught Exception');
  });

  process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled Rejection at:', promise, 'reason:', reason);
    cleanup('Unhandled Rejection');
  });

  try {
    log.info('Starting Apple TV tunnel...');
    const result = await tunnelService.startTunnel(undefined, specificDeviceIdentifier);
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
          packetStreamPort: packetStreamPort,
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
    log.info(`   http://localhost:${DEFAULT_TUNNEL_REGISTRY_PORT}/remotexpc/tunnels`);
    log.info('   - GET /remotexpc/tunnels - List all tunnels');
    log.info(`   - GET /remotexpc/tunnels/${deviceInfo.identifier} - Get tunnel by identifier`);
    log.info('   - GET /remotexpc/tunnels/metadata - Get registry metadata');

    log.info('\n✅ Apple TV tunnel is ready!');
    log.info(`Use: --rsd ${tunnel.Address} ${tunnel.RsdPort}`);
    log.info('\nPress Ctrl+C to close the tunnel and exit.');

    process.stdin.resume();
  } catch (error) {
    log.error('Tunnel failed:', error);
    await cleanup('Error');
  }
}

main().catch(async (error) => {
  log.error('Fatal error:', error);
  process.exit(1);
});
