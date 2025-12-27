import { util } from '@appium/support';
import { lookup } from 'node:dns/promises';
import * as tls from 'node:tls';

import type { AppleTVDevice } from '../../bonjour/bonjour-discovery.js';
import { BonjourDiscovery } from '../../bonjour/bonjour-discovery.js';
import { getLogger } from '../../logger.js';
import { DEFAULT_PAIRING_CONFIG } from '../constants.js';
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
import type { TcpListenerInfo, TlsPskConnectionOptions } from './types.js';

const appleTVLog = getLogger('AppleTVTunnelService');

export class TunnelService {
  private static readonly log = getLogger('TunnelService');
  private encryptedSequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly keys: VerificationKeys,
    private sequenceNumber: number,
  ) {}

  async createTcpListener(): Promise<TcpListenerInfo> {
    TunnelService.log.debug('Creating TCP listener (Encrypted Request)');

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
        'No encrypted response received',
        'NO_ENCRYPTED_RESPONSE',
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
      TunnelService.log.error('Invalid createListener response:', responseJson);
      throw new PairingError(
        'No port in createListener response',
        'NO_LISTENER_PORT',
      );
    }

    TunnelService.log.debug(
      `TCP Listener created on port: ${createListenerResponse.port}`,
    );

    return createListenerResponse;
  }

  async createTlsPskConnection(
    hostname: string,
    port: number,
  ): Promise<tls.TLSSocket> {
    TunnelService.log.debug(
      `Creating TLS-PSK connection to ${hostname}:${port}`,
    );

    return new Promise((resolve, reject) => {
      const options: TlsPskConnectionOptions = {
        host: hostname,
        port,
        pskCallback: (hint: string | null) => {
          TunnelService.log.debug(`PSK callback invoked with hint: ${hint}`);
          return {
            psk: this.keys.encryptionKey,
            identity: '',
          };
        },
        ciphers:
          'PSK-AES256-CBC-SHA:PSK-AES128-CBC-SHA:PSK-3DES-EDE-CBC-SHA:PSK-RC4-SHA:PSK',
        secureProtocol: 'TLSv1_2_method',
        // SECURITY NOTE: Disabling certificate validation is intentional and safe in this context.
        // This connection uses TLS-PSK (Pre-Shared Key) authentication, where the pre-shared key
        // itself provides mutual authentication between client and server. Traditional X.509
        // certificate validation is not used in PSK-based TLS connections. The encryption key
        // was securely established during the pairing process (which involves PIN verification),
        // and this key authenticates both parties. This is the standard approach for Apple TV's
        // RemoteXPC protocol and should NOT be changed to use certificate validation.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      };

      const socket = tls.connect(options, () => {
        TunnelService.log.debug('TLS-PSK connection established');
        resolve(socket);
      });

      socket.on('error', (error: Error & { code?: string }) => {
        TunnelService.log.error('TLS-PSK connection error:', error);

        if (
          error.message?.includes('no shared cipher') ||
          error.code === 'ECONNRESET'
        ) {
          TunnelService.log.error(
            'PSK ciphers may not be available in your Node.js build',
          );
          TunnelService.log.error('You may need to:');
          TunnelService.log.error(
            '1. Use Node.js compiled with PSK-enabled OpenSSL',
          );
          TunnelService.log.error(
            '2. Use a Python subprocess for the TLS-PSK connection',
          );
          TunnelService.log.error('3. Use a native module like node-openssl');
        }

        reject(error);
      });

      socket.on('secureConnect', () => {
        TunnelService.log.debug('Secure connection event fired');
      });

      socket.on('tlsClientError', (error) => {
        TunnelService.log.error('TLS client error:', error);
      });
    });
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }
}

/**
 * High-level service for establishing Apple TV tunnels.
 * Orchestrates device discovery, pairing verification, and tunnel creation.
 */
export class AppleTVTunnelService {
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

  async startTunnel(
    deviceId?: string,
    specificDeviceIdentifier?: string,
  ): Promise<{ socket: tls.TLSSocket; device: AppleTVDevice }> {
    const devices = await this.discoverDevices();

    appleTVLog.debug('Step 1: Device Discovery success');
    appleTVLog.debug(
      `Found ${util.pluralize('device', devices.length, true)} via Bonjour`,
    );

    // List all discovered devices
    if (devices.length > 0) {
      appleTVLog.info('\nDiscovered Apple TV devices:');
      devices.forEach((device, index) => {
        appleTVLog.info(`  ${index + 1}. Identifier: ${device.identifier}`);
        appleTVLog.info(`     Name: ${device.name}`);
        appleTVLog.info(`     IP: ${device.ip}:${device.port}`);
        appleTVLog.info(`     Model: ${device.model}`);
        appleTVLog.info(`     Version: ${device.version}`);
      });
    }

    // Filter devices by identifier if specified
    let devicesToProcess = devices;
    if (specificDeviceIdentifier) {
      devicesToProcess = devices.filter(
        (device) => device.identifier === specificDeviceIdentifier,
      );

      if (devicesToProcess.length === 0) {
        appleTVLog.error(
          `\nDevice with identifier ${specificDeviceIdentifier} not found in discovered devices.`,
        );
        appleTVLog.error('Available devices:');
        devices.forEach((device) => {
          appleTVLog.error(`  - ${device.identifier} (${device.name})`);
        });
        throw new Error(
          `Device with identifier ${specificDeviceIdentifier} not found. Please check available devices above.`,
        );
      }

      appleTVLog.info(
        `\nFiltered to specific device: ${specificDeviceIdentifier}`,
      );
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
        appleTVLog.debug(
          `\n--- Attempting connection with pair record: ${identifier} ---`,
        );
        appleTVLog.debug(`Device: ${device.ip}:${device.port}`);

        const pairRecord = await this.storage.load(identifier);
        if (!pairRecord) {
          appleTVLog.debug(`Failed to load pair record for ${identifier}`);
          failedAttempts.push({
            identifier,
            error: 'Failed to load pair record',
          });
          continue;
        }

        try {
          this.sequenceNumber = 0;
          await this.networkClient.connect(device.ip!, device.port);

          try {
            await this.performHandshake();

            const keys = await this.performPairVerification(
              pairRecord,
              identifier,
            );
            appleTVLog.info(
              `✅ Successfully verified with pair record: ${identifier}`,
            );

            const listenerInfo = await this.createTcpListener(keys);
            this.networkClient.disconnect();

            const tlsSocket = await this.createTlsPskConnection(
              device.ip!,
              listenerInfo.port,
              keys,
            );

            appleTVLog.debug('Step 6: Tunnel Establishment success');
            appleTVLog.info(`🔑 Using pair record: ${identifier}`);
            appleTVLog.info(
              `📱 Connected to device: ${device.identifier} (${device.name})`,
            );
            appleTVLog.info(`   IP: ${device.ip}:${device.port}`);

            return { socket: tlsSocket, device };
          } catch (error: any) {
            const errorMessage = error.message || String(error);
            appleTVLog.debug(
              `❌ Failed with pair record ${identifier}: ${errorMessage}`,
            );
            failedAttempts.push({ identifier, error: errorMessage });
            this.networkClient.disconnect();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        } catch (connectionError: any) {
          const errorMessage =
            connectionError.message || String(connectionError);
          appleTVLog.debug(
            `Failed to connect to ${device.ip}:${device.port}: ${errorMessage}`,
          );
          failedAttempts.push({
            identifier,
            error: `Connection failed: ${errorMessage}`,
          });
          this.networkClient.disconnect();
        }
      }
    }

    appleTVLog.error('\n=== Pair Record Verification Summary ===');
    appleTVLog.error(`Total pair records tried: ${failedAttempts.length}`);
    failedAttempts.forEach(({ identifier, error }) => {
      appleTVLog.error(`  - ${identifier}: ${error}`);
    });
    appleTVLog.error('=======================================\n');

    throw new Error(
      'Failed to establish tunnel with any pair record. All authentication attempts failed.',
    );
  }

  private async discoverDevices(): Promise<AppleTVDevice[]> {
    const discovery = new BonjourDiscovery();

    await discovery.startBrowsing('_remotepairing._tcp', 'local');
    await new Promise((resolve) =>
      setTimeout(resolve, DEFAULT_PAIRING_CONFIG.discoveryTimeout),
    );

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
            resolved.hostname.endsWith('.')
              ? resolved.hostname.slice(0, -1)
              : resolved.hostname,
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
        appleTVLog.debug(`Failed to resolve service ${service.name}: ${err}`);
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

    appleTVLog.debug('Step 2: Initial Connection & Handshake success');
  }

  private async performPairVerification(
    pairRecord: PairRecord,
    deviceId: string,
  ): Promise<VerificationKeys> {
    appleTVLog.debug('Step 3: Pair Verification (4-step process)');

    const verificationProtocol = new PairVerificationProtocol(
      this.networkClient,
    );
    verificationProtocol.setSequenceNumber(this.sequenceNumber);
    const keys = await verificationProtocol.verify(pairRecord, deviceId);

    this.sequenceNumber = verificationProtocol.getSequenceNumber();

    appleTVLog.debug('Step 4: Main Encryption Key Derivation success');

    return keys;
  }

  private async createTcpListener(
    keys: VerificationKeys,
  ): Promise<{ port: number; serviceName: string; devicePublicKey: string }> {
    appleTVLog.debug('Step 5: TCP Listener Creation (Encrypted Request)');

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
