import { util } from '@appium/support';
import * as tls from 'node:tls';

import { createDiscoveryBackend } from '../../discovery/discovery-backend-factory.js';
import { getLogger } from '../../logger.js';
import {
  DEFAULT_PAIRING_CONFIG,
  REMOTE_PAIRING_DISCOVERY_DOMAIN,
  REMOTE_PAIRING_DISCOVERY_SERVICE_TYPE,
} from '../constants.js';
import { enrichDiscoveredDevicesWithDevicectl } from '../devicectl-enrichment.js';
import { toRemotePairingDevices } from '../discovered-device-mapper.js';
import {
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
} from '../encryption/index.js';
import { PairingError } from '../errors.js';
import { NetworkClient } from '../network/index.js';
import type { NetworkClientInterface } from '../network/types.js';
import { PairVerificationProtocol } from '../pairing-protocol/index.js';
import type { VerificationKeys } from '../pairing-protocol/pair-verification-protocol.js';
import { PairingStorage } from '../storage/pairing-storage.js';
import type { PairRecord } from '../storage/types.js';
import type { RemotePairingDevice } from '../types.js';
import type { TcpListenerInfo, TlsPskConnectionOptions } from './types.js';

const log = getLogger('TunnelService');
const remoteTunnelLog = getLogger('RemotePairingTunnelService');

export class TunnelService {
  private encryptedSequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly keys: VerificationKeys,
    private sequenceNumber: number,
  ) {}

  async createTcpListener(): Promise<TcpListenerInfo> {
    log.debug('Creating TCP listener (Encrypted Request)');

    const request = {
      request: {
        _0: {
          createListener: {
            key: this.keys.encryptionKey.toString('base64'),
            peerConnectionsInfo: [
              {
                owningPID: process.pid,
                owningProcessName: 'CoreDeviceService',
              },
            ],
            transportProtocolType: 'tcp',
          },
        },
      },
    };

    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber), 0);

    const requestJson = JSON.stringify(request);

    const encrypted = encryptChaCha20Poly1305({
      plaintext: Buffer.from(requestJson, 'utf8'),
      key: this.keys.clientEncryptionKey,
      nonce,
    });

    const encryptedPayload = {
      message: {
        streamEncrypted: {
          _0: encrypted.toString('base64'),
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };

    await this.networkClient.sendPacket(encryptedPayload);
    this.encryptedSequenceNumber++;

    const response = await this.networkClient.receiveResponse();

    const encryptedData = response.message?.streamEncrypted?._0;

    if (!encryptedData) {
      throw new PairingError(
        'Failed to receive encrypted response from device',
        'ENCRYPTED_RESPONSE_MISSING',
        { response },
      );
    }

    const responseNonce = Buffer.alloc(12);
    responseNonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber - 1), 0);

    const decrypted = decryptChaCha20Poly1305({
      ciphertext: Buffer.from(encryptedData, 'base64'),
      key: this.keys.serverEncryptionKey,
      nonce: responseNonce,
    });

    const responseJson = JSON.parse(decrypted.toString('utf8'));
    const createListenerResponse = responseJson?.response?._1?.createListener;

    if (!createListenerResponse?.port) {
      log.error('Invalid createListener response:', responseJson);
      throw new PairingError(
        'TCP listener creation failed: missing port in response',
        'LISTENER_PORT_MISSING',
        { response: responseJson },
      );
    }

    log.debug(`TCP Listener created on port: ${createListenerResponse.port}`);

    return createListenerResponse;
  }

  async createTlsPskConnection(
    hostname: string,
    port: number,
  ): Promise<tls.TLSSocket> {
    log.debug(`Creating TLS-PSK connection to ${hostname}:${port}`);

    return new Promise((resolve, reject) => {
      const options: TlsPskConnectionOptions = {
        host: hostname,
        port,
        pskCallback: (hint: string | null) => {
          log.debug(`PSK callback invoked with hint: ${hint}`);
          return {
            psk: this.keys.encryptionKey,
            identity: '',
          };
        },
        ciphers:
          'PSK-AES256-CBC-SHA:PSK-AES128-CBC-SHA:PSK-3DES-EDE-CBC-SHA:PSK-RC4-SHA:PSK',
        secureProtocol: 'TLSv1_2_method',
        // SECURITY NOTE: Disabling certificate validation is intentional and safe in this context.
        // TLS-PSK: the pre-shared key authenticates both sides; no X.509 validation.
        // The key comes from Remote Pairing pair-verify. Same pattern as Core Device tunneling.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      };

      const socket = tls.connect(options, () => {
        log.debug('TLS-PSK connection established');
        resolve(socket);
      });

      socket.on('error', (error: Error & { code?: string }) => {
        log.error('TLS-PSK connection error:', error);

        if (
          error.message?.includes('no shared cipher') ||
          error.code === 'ECONNRESET'
        ) {
          log.error('PSK ciphers may not be available in your Node.js build');
          log.error('You may need to:');
          log.error('1. Use Node.js compiled with PSK-enabled OpenSSL');
          log.error('2. Use a Python subprocess for the TLS-PSK connection');
          log.error('3. Use a native module like node-openssl');
        }

        reject(error);
      });

      socket.on('secureConnect', () => {
        log.debug('Secure connection event fired');
      });

      socket.on('tlsClientError', (error) => {
        log.error('TLS client error:', error);
      });
    });
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }
}

/**
 * High-level service for Wi‑Fi Remote Pairing tunnels (`_remotepairing._tcp`).
 * Orchestrates discovery, pair verification, and TLS-PSK tunnel creation.
 */
export class RemotePairingTunnelService {
  private readonly networkClient: NetworkClient;
  private readonly storage: PairingStorage;
  private sequenceNumber = 0;

  constructor() {
    this.networkClient = new NetworkClient(DEFAULT_PAIRING_CONFIG);
    this.storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
  }

  disconnect(): void {
    this.networkClient.disconnect();
  }

  async startTunnel(
    deviceId?: string,
    specificDeviceIdentifier?: string,
  ): Promise<{ socket: tls.TLSSocket; device: RemotePairingDevice }> {
    const devices = await this.discoverDevices();
    this.logDiscoveredDevices(devices);

    const devicesToProcess = this.selectDevicesToProcess(
      devices,
      specificDeviceIdentifier,
    );
    const identifiersToTry = await this.validateAndGetPairRecords(deviceId);

    const failedAttempts: { identifier: string; error: string }[] = [];

    for (const device of devicesToProcess) {
      for (const identifier of identifiersToTry) {
        remoteTunnelLog.debug(
          `\n--- Attempting connection with pair record: ${identifier} ---`,
        );
        remoteTunnelLog.debug(`Device: ${device.ip}:${device.port}`);

        const pairRecord = await this.storage.load(identifier);
        if (!pairRecord) {
          remoteTunnelLog.debug(`Failed to load pair record for ${identifier}`);
          failedAttempts.push({
            identifier,
            error: 'Failed to load pair record',
          });
          continue;
        }

        const result = await this.attemptDeviceConnection(
          device,
          identifier,
          pairRecord,
          failedAttempts,
        );

        if (result) {
          return result;
        }
      }
    }

    this.logFailureSummary(failedAttempts);

    throw new Error(
      'Failed to establish tunnel with any pair record. All authentication attempts failed.',
    );
  }

  /**
   * Logs information about discovered devices
   */
  private logDiscoveredDevices(devices: RemotePairingDevice[]): void {
    remoteTunnelLog.debug('Step 1: Device Discovery success');
    remoteTunnelLog.debug(
      `Found ${util.pluralize('device', devices.length, true)} via discovery backend`,
    );

    if (devices.length > 0) {
      remoteTunnelLog.info('\nDiscovered Remote Pairing devices:');
      devices.forEach((device, index) => {
        remoteTunnelLog.info(
          `  ${index + 1}. Identifier: ${device.identifier}`,
        );
        remoteTunnelLog.info(`     Name: ${device.name}`);
        remoteTunnelLog.info(`     IP: ${device.ip}:${device.port}`);
        remoteTunnelLog.info(`     Model: ${device.model}`);
        remoteTunnelLog.info(`     Version: ${device.version}`);
      });
    }
  }

  /**
   * Selects devices to process based on the specific device identifier
   */
  private selectDevicesToProcess(
    devices: RemotePairingDevice[],
    specificDeviceIdentifier?: string,
  ): RemotePairingDevice[] {
    if (!specificDeviceIdentifier) {
      return devices;
    }

    const filteredDevices = devices.filter(
      (device) => device.identifier === specificDeviceIdentifier,
    );

    if (filteredDevices.length === 0) {
      remoteTunnelLog.error(
        `\nDevice with identifier ${specificDeviceIdentifier} not found in discovered devices.`,
      );
      remoteTunnelLog.error('Available devices:');
      devices.forEach((device) => {
        remoteTunnelLog.error(`  - ${device.identifier} (${device.name})`);
      });
      throw new Error(
        `Device with identifier ${specificDeviceIdentifier} not found. Please check available devices above.`,
      );
    }

    remoteTunnelLog.info(
      `\nFiltered to specific device: ${specificDeviceIdentifier}`,
    );

    return filteredDevices;
  }

  /**
   * Validates pair records and returns the list of identifiers to try
   */
  private async validateAndGetPairRecords(
    deviceId?: string,
  ): Promise<string[]> {
    const availableDeviceIds = await this.storage.getAvailableDeviceIds();

    if (availableDeviceIds.length === 0) {
      throw new Error('No pair records found');
    }

    if (deviceId && !availableDeviceIds.includes(deviceId)) {
      throw new Error(`No pair record found for specified device ${deviceId}`);
    }

    return deviceId ? [deviceId] : availableDeviceIds;
  }

  /**
   * Attempts to establish a connection with a device using a specific pair record
   */
  private async attemptDeviceConnection(
    device: RemotePairingDevice,
    identifier: string,
    pairRecord: PairRecord,
    failedAttempts: { identifier: string; error: string }[],
  ): Promise<{ socket: tls.TLSSocket; device: RemotePairingDevice } | null> {
    const connectionTarget = device.ip ?? device.hostname;
    if (!connectionTarget) {
      failedAttempts.push({
        identifier,
        error: 'Connection failed: no IP or hostname available',
      });
      return null;
    }

    try {
      this.sequenceNumber = 0;
      await this.networkClient.connect(connectionTarget, device.port);

      try {
        await this.performHandshake();

        const keys = await this.performPairVerification(pairRecord, identifier);
        remoteTunnelLog.info(
          `✅ Successfully verified with pair record: ${identifier}`,
        );

        const listenerInfo = await this.createTcpListener(keys);
        this.networkClient.disconnect();

        const tlsSocket = await this.createTlsPskConnection(
          connectionTarget,
          listenerInfo.port,
          keys,
        );

        remoteTunnelLog.debug('Step 6: Tunnel Establishment success');
        remoteTunnelLog.info(`🔑 Using pair record: ${identifier}`);
        remoteTunnelLog.info(
          `📱 Connected to device: ${device.identifier} (${device.name})`,
        );
        remoteTunnelLog.info(`   Target: ${connectionTarget}:${device.port}`);

        return { socket: tlsSocket, device };
      } catch (error: any) {
        const errorMessage = error.message || String(error);
        remoteTunnelLog.debug(
          `❌ Failed with pair record ${identifier}: ${errorMessage}`,
        );
        failedAttempts.push({ identifier, error: errorMessage });
        this.networkClient.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (connectionError: any) {
      const errorMessage = connectionError.message || String(connectionError);
      remoteTunnelLog.debug(
        `Failed to connect to ${connectionTarget}:${device.port}: ${errorMessage}`,
      );
      failedAttempts.push({
        identifier,
        error: `Connection failed: ${errorMessage}`,
      });
      this.networkClient.disconnect();
    }

    return null;
  }

  /**
   * Logs a summary of all failed connection attempts
   */
  private logFailureSummary(
    failedAttempts: { identifier: string; error: string }[],
  ): void {
    remoteTunnelLog.error('\n=== Pair Record Verification Summary ===');
    remoteTunnelLog.error(`Total pair records tried: ${failedAttempts.length}`);
    failedAttempts.forEach(({ identifier, error }) => {
      remoteTunnelLog.error(`  - ${identifier}: ${error}`);
    });
    remoteTunnelLog.error('=======================================\n');
  }

  private async discoverDevices(): Promise<RemotePairingDevice[]> {
    const backend = createDiscoveryBackend(process.platform, {
      serviceType: REMOTE_PAIRING_DISCOVERY_SERVICE_TYPE,
      domain: REMOTE_PAIRING_DISCOVERY_DOMAIN,
    });
    const discoveredDevices = await backend.discoverDevices(
      DEFAULT_PAIRING_CONFIG.discoveryTimeout,
    );
    const enrichedDevices =
      await enrichDiscoveredDevicesWithDevicectl(discoveredDevices);
    const devices = toRemotePairingDevices(enrichedDevices);
    if (devices.length === 0) {
      throw new Error('No devices found via discovery backend');
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

    remoteTunnelLog.debug('Step 2: Initial Connection & Handshake success');
  }

  private async performPairVerification(
    pairRecord: PairRecord,
    deviceId: string,
  ): Promise<VerificationKeys> {
    remoteTunnelLog.debug('Step 3: Pair Verification (4-step process)');

    const verificationProtocol = new PairVerificationProtocol(
      this.networkClient,
    );
    verificationProtocol.setSequenceNumber(this.sequenceNumber);
    const keys = await verificationProtocol.verify(pairRecord, deviceId);

    this.sequenceNumber = verificationProtocol.getSequenceNumber();

    remoteTunnelLog.debug('Step 4: Main Encryption Key Derivation success');

    return keys;
  }

  private async createTcpListener(
    keys: VerificationKeys,
  ): Promise<{ port: number; serviceName: string; devicePublicKey: string }> {
    remoteTunnelLog.debug('Step 5: TCP Listener Creation (Encrypted Request)');

    const tunnelService = new TunnelService(
      this.networkClient,
      keys,
      this.sequenceNumber,
    );
    const listenerInfo = await tunnelService.createTcpListener();

    this.sequenceNumber = tunnelService.getSequenceNumber();

    return listenerInfo;
  }

  private async createTlsPskConnection(
    hostname: string,
    port: number,
    keys: VerificationKeys,
  ): Promise<tls.TLSSocket> {
    const tunnelService = new TunnelService(
      this.networkClient,
      keys,
      this.sequenceNumber,
    );
    return tunnelService.createTlsPskConnection(hostname, port);
  }
}
