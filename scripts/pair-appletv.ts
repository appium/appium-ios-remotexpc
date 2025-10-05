#!/usr/bin/env node
import { logger } from '@appium/support';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  DEFAULT_PAIRING_CONFIG,
  NetworkError,
  PairingDataComponentType,
  PairingError,
  SRPClient,
  createEd25519Signature,
  createPairVerificationData,
  createSetupManualPairingData,
  decodeTLV8ToDict,
  decryptChaCha20Poly1305,
  encodeAppleTVDeviceInfo,
  encodeTLV8,
  encryptChaCha20Poly1305,
  generateEd25519KeyPair,
  generateHostId,
  hkdf,
  type PairingConfig,
  type PairingResult,
  type TLV8Item,
} from '../src/lib/apple-tv/index.js';
import { type AppleTVDevice, BonjourDiscovery } from '../src/lib/bonjour/bonjour-discovery.js';
import { createXmlPlist } from '../src/lib/plist/index.js';

/** Interface for network communication with Apple TV devices */
interface NetworkClientInterface {
  connect(ip: string, port: number): Promise<void>;
  sendPacket(data: any): Promise<void>;
  receiveResponse(): Promise<any>;
  disconnect(): void;
}

/** Interface for storing pairing credentials to disk */
interface PairingStorageInterface {
  save(deviceId: string, ltpk: Buffer, ltsk: Buffer, remoteUnlockHostKey?: string): string;
}

/** Interface for handling user input during pairing process */
interface UserInputInterface {
  promptForPIN(): Promise<string>;
}

/** Interface for executing the Apple TV pairing protocol flow */
interface PairingProtocolInterface {
  executePairingFlow(device: AppleTVDevice): Promise<string>;
}

/** Encryption keys derived from SRP session key for secure communication */
interface EncryptionKeys {
  encryptKey: Buffer;
  decryptKey: Buffer;
}

/** Structure of a pairing request message sent to Apple TV */
interface PairingRequest {
  message: {
    plain: {
      _0: any;
    };
  };
  originatedBy: string;
  sequenceNumber: number;
}

/** Handles TCP socket communication with Apple TV devices */
export class NetworkClient implements NetworkClientInterface {
  private socket: net.Socket | null = null;
  private readonly log = logger.getLogger('NetworkClient');

  constructor(private readonly config: PairingConfig) {}

  async connect(ip: string, port: number): Promise<void> {
    try {
      this.log.debug(`Connecting to ${ip}:${port}`);

      return new Promise((resolve, reject) => {
        this.socket = net.connect(port, ip);

        const timeout = setTimeout(() => {
          this.cleanup();
          reject(new NetworkError('Connection timeout'));
        }, this.config.timeout);

        this.socket.on('connect', () => {
          clearTimeout(timeout);
          this.log.debug('Connected successfully');
          resolve();
        });

        this.socket.on('error', (error) => {
          clearTimeout(timeout);
          this.cleanup();
          this.log.error('Connection error:', error);
          reject(new NetworkError('Connection failed'));
        });

        this.socket.setTimeout(this.config.timeout);
      });
    } catch (error) {
      this.log.error('Connect failed:', error);
      throw new NetworkError('Failed to initiate connection');
    }
  }

  async sendPacket(data: any): Promise<void> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    try {
      const packet = this.createRPPairingPacket(data);
      this.log.debug('Sending packet:', { size: packet.length });

      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject(new NetworkError('Socket disconnected during send'));
          return;
        }

        this.socket.write(packet, (error) => {
          if (error) {
            this.log.error('Send packet error:', error);
            reject(new NetworkError('Failed to send packet'));
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      this.log.error('Create packet error:', error);
      throw new NetworkError('Failed to create packet');
    }
  }

  async receiveResponse(): Promise<any> {
    if (!this.socket) {
      throw new NetworkError('Socket not connected');
    }

    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let expectedLength: number | null = null;
      let headerRead = false;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new NetworkError('Response timeout'));
      }, this.config.timeout);

      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        try {
          if (!headerRead && buffer.length >= 11) {
            const magic = buffer.slice(0, 9).toString('ascii');
            if (magic !== 'RPPairing') {
              throw new NetworkError(`Invalid magic: ${magic}`);
            }
            expectedLength = buffer.readUInt16BE(9);
            headerRead = true;
          }

          if (headerRead && expectedLength !== null && buffer.length >= 11 + expectedLength) {
            const bodyBytes = buffer.slice(11, 11 + expectedLength);
            const response = JSON.parse(bodyBytes.toString('utf8'));
            cleanup();
            resolve(response);
          }
        } catch (error) {
          cleanup();
          this.log.error('Parse response error:', error);
          reject(new NetworkError('Failed to parse response'));
        }
      };

      const onError = (error: Error) => {
        cleanup();
        this.log.error('Socket error:', error);
        reject(new NetworkError('Socket error'));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        if (this.socket) {
          this.socket.removeListener('data', onData);
          this.socket.removeListener('error', onError);
        }
      };

      if (this.socket) {
        this.socket.on('data', onData);
        this.socket.on('error', onError);
      } else {
        cleanup();
        reject(new NetworkError('Socket not available'));
      }
    });
  }

  disconnect(): void {
    this.cleanup();
  }

  private createRPPairingPacket(jsonData: any): Buffer {
    const jsonString = JSON.stringify(jsonData);
    const bodyBytes = Buffer.from(jsonString, 'utf8');
    const magic = Buffer.from('RPPairing', 'ascii');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bodyBytes.length, 0);
    return Buffer.concat([magic, length, bodyBytes]);
  }

  private cleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/** Manages persistent storage of pairing credentials as plist files */
export class PairingStorage implements PairingStorageInterface {
  private readonly log = logger.getLogger('PairingStorage');

  constructor(private readonly config: PairingConfig) {}

  save(deviceId: string, ltpk: Buffer, ltsk: Buffer, remoteUnlockHostKey = ''): string {
    try {
      const projectRoot = join(import.meta.dirname, '..');
      const pairingDir = join(projectRoot, this.config.pairingDirectory);

      if (!existsSync(pairingDir)) {
        mkdirSync(pairingDir, { recursive: true });
      }

      const pairingFile = join(pairingDir, `remote_${deviceId}.plist`);
      const plistContent = this.createPlistContent(ltpk, ltsk, remoteUnlockHostKey);

      writeFileSync(pairingFile, plistContent);
      this.log.info(`Pairing record saved to: ${pairingFile}`);

      return pairingFile;
    } catch (error) {
      this.log.error('Save pairing record error:', error);
      throw new PairingError('Failed to save pairing record', 'SAVE_ERROR', error);
    }
  }

  private createPlistContent(publicKey: Buffer, privateKey: Buffer, remoteUnlockHostKey: string): string {
    return createXmlPlist({
      private_key: privateKey,
      public_key: publicKey,
      remote_unlock_host_key: remoteUnlockHostKey,
    });
  }
}

/** Handles user interaction for PIN input during pairing */
export class UserInputService implements UserInputInterface {
  private readonly log = logger.getLogger('UserInputService');

  async promptForPIN(): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      const questionPromise = new Promise<string>((resolve) => {
        rl.question('Enter PIN from Apple TV screen: ', (answer) => {
          resolve(answer);
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new PairingError('PIN input timeout', 'INPUT_TIMEOUT'));
        }, 120000);
      });

      const pin = await Promise.race([questionPromise, timeoutPromise]);

      const cleanPin = pin.trim();
      if (!cleanPin.length || !/^\d+$/.test(cleanPin)) {
        this.log.error('Invalid PIN format');
        throw new PairingError('PIN must contain only digits', 'INVALID_PIN');
      }

      this.log.debug('PIN received successfully');
      return cleanPin;
    } finally {
      rl.close();
    }
  }
}

/** Implements the Apple TV pairing protocol including SRP authentication and key exchange */
export class PairingProtocol implements PairingProtocolInterface {
  private readonly log = logger.getLogger('PairingProtocol');
  private _sequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly userInput: UserInputInterface
  ) {}

  private get sequenceNumber(): number {
    return this._sequenceNumber;
  }

  private set sequenceNumber(value: number) {
    this._sequenceNumber = value;
  }

  async executePairingFlow(device: AppleTVDevice): Promise<string> {
    this.sequenceNumber = 1;

    try {
      // Step 1: Handshake
      await this.performHandshake();

      // Step 2: Pair verification attempt
      await this.attemptPairVerification();

      // Step 3: Setup manual pairing
      const setupResponse = await this.setupManualPairing();
      const srpData = this.extractAndValidatePairingData(setupResponse);

      // Step 4: SRP Authentication
      const srpClient = await this.performSRPAuthentication(srpData);

      // Step 5: Generate keys and send M5
      const encryptionKeys = this.deriveEncryptionKeys(srpClient.sessionKey);
      const { publicKey: ltpk, privateKey: ltsk } = generateEd25519KeyPair();
      const devicePairingID = generateHostId(hostname());

      await this.sendM5Message(encryptionKeys.encryptKey, devicePairingID, ltpk, ltsk, srpClient.sessionKey);

      // Step 6: Receive M6 completion
      await this.receiveM6Completion(encryptionKeys.decryptKey);

      return this.createPairingResult(device, ltpk, ltsk);
    } catch (error) {
      this.log.error('Pairing flow failed:', error);
      throw error;
    }
  }

  private async performHandshake(): Promise<void> {
    const request = this.createHandshakeRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();
    this.log.debug('Handshake completed');
  }

  private async attemptPairVerification(): Promise<void> {
    const request = this.createPairVerificationRequest();
    await this.networkClient.sendPacket(request);
    await this.networkClient.receiveResponse();

    const failedRequest = this.createPairVerifyFailedRequest();
    await this.networkClient.sendPacket(failedRequest);
    this.log.debug('Pair verification attempt completed');
  }

  private async setupManualPairing(): Promise<any> {
    const request = this.createSetupManualPairingRequest();
    await this.networkClient.sendPacket(request);
    const response = await this.networkClient.receiveResponse();
    this.log.debug('Manual pairing setup completed');
    return response;
  }

  private extractAndValidatePairingData(response: any): Record<number, Buffer> {
    const srpData = response.message?.plain?._0?.event?._0?.pairingData?._0?.data;
    if (!srpData) {
      throw new PairingError('No pairing data received', 'NO_PAIRING_DATA');
    }

    const parsedSRP = this.parseTLV8Response(srpData);
    this.validateSRPResponse(parsedSRP);
    return parsedSRP;
  }

  private async performSRPAuthentication(parsedSRP: Record<number, Buffer>): Promise<SRPClient> {
    const pin = await this.userInput.promptForPIN();
    const srpClient = this.createSRPClient(pin, parsedSRP);

    await this.sendSRPProof(srpClient);
    const response = await this.networkClient.receiveResponse();
    this.validateSRPProofResponse(response);

    this.log.debug('SRP authentication completed');
    return srpClient;
  }

  private async receiveM6Completion(decryptKey: Buffer): Promise<void> {
    const m6Response = await this.networkClient.receiveResponse();
    this.log.info('M6 Response received');

    try {
      this.processM6Response(m6Response, decryptKey);
    } catch (error) {
      this.log.warn('M6 decryption failed - but pairing may still be successful:', (error as Error).message);
    }
  }

  private createHandshakeRequest(): PairingRequest {
    return {
      message: {
        plain: {
          _0: {
            request: {
              _0: {
                handshake: {
                  _0: {
                    hostOptions: { attemptPairVerify: true },
                    wireProtocolVersion: 19
                  }
                }
              }
            }
          }
        }
      },
      originatedBy: 'host',
      sequenceNumber: 0
    };
  }

  private createPairVerificationRequest(): PairingRequest {
    const x25519PublicKey = randomBytes(32);
    const pairingData = createPairVerificationData(x25519PublicKey);

    return {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairingData: {
                  _0: {
                    data: pairingData,
                    kind: 'verifyManualPairing',
                    startNewSession: true
                  }
                }
              }
            }
          }
        }
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++
    };
  }

  private createPairVerifyFailedRequest(): PairingRequest {
    return {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairVerifyFailed: {}
              }
            }
          }
        }
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++
    };
  }

  private createSetupManualPairingRequest(): PairingRequest {
    const setupData = createSetupManualPairingData();

    return {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairingData: {
                  _0: {
                    data: setupData,
                    kind: 'setupManualPairing',
                    sendingHost: hostname(),
                    startNewSession: true
                  }
                }
              }
            }
          }
        }
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++
    };
  }

  private parseTLV8Response(data: string): Record<number, Buffer> {
    try {
      const buffer = Buffer.from(data, 'base64');
      const decoded = decodeTLV8ToDict(buffer);

      const result: Record<number, Buffer> = {};
      for (const [key, value] of Object.entries(decoded)) {
        if (value !== undefined) {
          result[Number(key)] = value;
        }
      }
      return result;
    } catch (error) {
      throw new PairingError('Failed to parse TLV8 response', 'TLV8_PARSE_ERROR', error);
    }
  }

  private validateSRPResponse(parsedSRP: Record<number, Buffer>): void {
    const errorBuffer = parsedSRP[PairingDataComponentType.ERROR];
    if (errorBuffer) {
      if (errorBuffer.length === 0) {
        throw new PairingError('Apple TV returned empty error buffer', 'INVALID_ERROR_RESPONSE');
      }
      const errorCode = errorBuffer[0];
      throw new PairingError(`Apple TV rejected request with error ${errorCode}`, 'APPLE_TV_ERROR', { errorCode });
    }

    if (!parsedSRP[PairingDataComponentType.SALT] || !parsedSRP[PairingDataComponentType.PUBLIC_KEY]) {
      throw new PairingError('Missing SRP challenge data', 'MISSING_SRP_DATA');
    }
  }

  private createSRPClient(pin: string, parsedSRP: Record<number, Buffer>): SRPClient {
    try {
      const salt = parsedSRP[PairingDataComponentType.SALT];
      const serverPublicKey = parsedSRP[PairingDataComponentType.PUBLIC_KEY];

      if (!salt || !serverPublicKey) {
        throw new PairingError('Missing required SRP data', 'MISSING_SRP_DATA');
      }

      const srpClient = new SRPClient();
      srpClient.setIdentity('Pair-Setup', pin);
      srpClient.salt = salt;
      srpClient.serverPublicKey = serverPublicKey;
      return srpClient;
    } catch (error) {
      throw new PairingError('Failed to create SRP client', 'SRP_CLIENT_ERROR', error);
    }
  }

  private async sendSRPProof(srpClient: SRPClient): Promise<void> {
    const clientPublicKey = srpClient.publicKey;
    const clientProof = srpClient.computeProof();

    const tlvItems: TLV8Item[] = [
      { type: PairingDataComponentType.STATE, data: Buffer.from([0x03]) }
    ];

    // Fragment public key if necessary
    for (let i = 0; i < clientPublicKey.length; i += 255) {
      const fragment = clientPublicKey.slice(i, i + 255);
      tlvItems.push({ type: PairingDataComponentType.PUBLIC_KEY, data: fragment });
    }

    tlvItems.push({ type: PairingDataComponentType.PROOF, data: clientProof });
    const tlv = encodeTLV8(tlvItems);

    const request: PairingRequest = {
      message: {
        plain: {
          _0: {
            event: {
              _0: {
                pairingData: {
                  _0: {
                    data: tlv.toString('base64'),
                    kind: 'setupManualPairing',
                    sendingHost: hostname(),
                    startNewSession: false
                  }
                }
              }
            }
          }
        }
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++
    };

    await this.networkClient.sendPacket(request);
  }

  private validateSRPProofResponse(response: any): void {
    if (response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      const proofData = Buffer.from(response.message.plain._0.event._0.pairingData._0.data, 'base64');
      const parsedProof = decodeTLV8ToDict(proofData);

      if (parsedProof[PairingDataComponentType.ERROR]) {
        throw new PairingError('SRP authentication failed - wrong PIN', 'WRONG_PIN');
      }
    }
  }

  private async sendM5Message(encryptKey: Buffer, devicePairingID: string, ltpk: Buffer, ltsk: Buffer, sessionKey: Buffer): Promise<void> {
    try {
      const signingKey = hkdf({
        ikm: sessionKey,
        salt: Buffer.from('Pair-Setup-Controller-Sign-Salt', 'utf8'),
        info: Buffer.from('Pair-Setup-Controller-Sign-Info', 'utf8'),
        length: 32
      });

      const devicePairingIDBuffer = Buffer.from(devicePairingID, 'utf8');
      const dataToSign = Buffer.concat([signingKey, devicePairingIDBuffer, ltpk]);
      const signature = createEd25519Signature(dataToSign, ltsk);
      const deviceInfo = encodeAppleTVDeviceInfo(devicePairingID);

      const INFO_TYPE = 0x11;
      const tlvItems: TLV8Item[] = [
        { type: PairingDataComponentType.IDENTIFIER, data: devicePairingIDBuffer },
        { type: PairingDataComponentType.PUBLIC_KEY, data: ltpk },
        { type: PairingDataComponentType.SIGNATURE, data: signature },
        { type: INFO_TYPE as any, data: deviceInfo }
      ];

      const tlvData = encodeTLV8(tlvItems);
      const nonce = Buffer.concat([Buffer.alloc(4), Buffer.from('PS-Msg05')]);
      const encrypted = encryptChaCha20Poly1305({
        plaintext: tlvData,
        key: encryptKey,
        nonce
      });

      const encryptedTLVItems: TLV8Item[] = [];
      for (let i = 0; i < encrypted.length; i += 255) {
        const fragment = encrypted.slice(i, Math.min(i + 255, encrypted.length));
        encryptedTLVItems.push({ type: PairingDataComponentType.ENCRYPTED_DATA, data: fragment });
      }

      encryptedTLVItems.push({ type: PairingDataComponentType.STATE, data: Buffer.from([0x05]) });
      const encryptedTLV = encodeTLV8(encryptedTLVItems);

      const request: PairingRequest = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  pairingData: {
                    _0: {
                      data: encryptedTLV.toString('base64'),
                      kind: 'setupManualPairing',
                      sendingHost: hostname(),
                      startNewSession: false
                    }
                  }
                }
              }
            }
          }
        },
        originatedBy: 'host',
        sequenceNumber: this.sequenceNumber++
      };

      await this.networkClient.sendPacket(request);
    } catch (error) {
      throw new PairingError('Failed to create M5 message', 'M5_ERROR', error);
    }
  }

  private processM6Response(m6Response: any, decryptKey: Buffer): void {
    if (!m6Response.message?.plain?._0?.event?._0?.pairingData?._0?.data) {
      return;
    }

    const m6DataBase64 = m6Response.message.plain._0.event._0.pairingData._0.data;
    const m6TLVBuffer = Buffer.from(m6DataBase64, 'base64');
    const m6Parsed = decodeTLV8ToDict(m6TLVBuffer);

    this.log.debug('M6 TLV types received:', Object.keys(m6Parsed).map((k) => `0x${Number(k).toString(16)}`));

    const stateData = m6Parsed[PairingDataComponentType.STATE];
    if (stateData && stateData[0] === 0x06) {
      this.log.info('✅ Pairing completed successfully (STATE=0x06)');
    }

    const encryptedData = m6Parsed[PairingDataComponentType.ENCRYPTED_DATA];
    if (encryptedData) {
      const nonce = Buffer.concat([Buffer.alloc(4), Buffer.from('PS-Msg06')]);
      const decrypted = decryptChaCha20Poly1305({
        ciphertext: encryptedData,
        key: decryptKey,
        nonce
      });
      const decryptedTLV = decodeTLV8ToDict(decrypted);
      this.log.debug('M6 decrypted content types:', Object.keys(decryptedTLV));
    }
  }

  private deriveEncryptionKeys(sessionKey: Buffer): EncryptionKeys {
    const sharedKey = hkdf({
      ikm: sessionKey,
      salt: Buffer.from('Pair-Setup-Encrypt-Salt', 'utf8'),
      info: Buffer.from('Pair-Setup-Encrypt-Info', 'utf8'),
      length: 32
    });

    this.log.debug('Derived encryption keys');
    return {
      encryptKey: sharedKey,
      decryptKey: sharedKey
    };
  }

  private createPairingResult(device: AppleTVDevice, ltpk: Buffer, ltsk: Buffer): string {
    const storage = new PairingStorage(DEFAULT_PAIRING_CONFIG);
    return storage.save(device.identifier || device.name, ltpk, ltsk);
  }
}

/** Discovers Apple TV devices on the local network using Bonjour */
export class DeviceDiscoveryService {
  private readonly log = logger.getLogger('DeviceDiscoveryService');

  constructor(private readonly config: PairingConfig) {}

  async discoverDevices(): Promise<AppleTVDevice[]> {
    try {
      const discovery = new BonjourDiscovery();
      this.log.info(`Discovering Apple TV devices (waiting ${this.config.discoveryTimeout / 1000} seconds)...`);
      return await discovery.discoverAppleTVDevicesWithIP(this.config.discoveryTimeout);
    } catch (error) {
      this.log.error('Device discovery failed:', error);
      throw new PairingError('Device discovery failed', 'DISCOVERY_ERROR', error);
    }
  }
}

/** Main service orchestrating Apple TV device discovery and pairing */
export class AppleTVPairingService {
  private readonly log = logger.getLogger('AppleTVPairingService');
  private readonly networkClient: NetworkClient;
  private readonly discoveryService: DeviceDiscoveryService;
  private readonly userInput: UserInputService;
  private readonly pairingProtocol: PairingProtocol;

  constructor(config: PairingConfig = DEFAULT_PAIRING_CONFIG) {
    this.networkClient = new NetworkClient(config);
    this.discoveryService = new DeviceDiscoveryService(config);
    this.userInput = new UserInputService();
    this.pairingProtocol = new PairingProtocol(
      this.networkClient,
      this.userInput,
    );
  }

  async discoverAndPair(): Promise<PairingResult> {
    try {
      const devices = await this.discoveryService.discoverDevices();

      if (devices.length === 0) {
        const errorMessage =
          'No Apple TV pairing devices found. Please ensure your Apple TV is on the same network and in pairing mode.';
        this.log.error(errorMessage);
        throw new PairingError(errorMessage, 'NO_DEVICES');
      }

      const device = devices[0];
      const pairingFile = await this.pairWithDevice(device);

      return {
        success: true,
        deviceId: device.identifier,
        pairingFile,
      };
    } catch (error) {
      this.log.error('Pairing failed:', error);
      return {
        success: false,
        deviceId: 'unknown',
        error: error as Error,
      };
    }
  }

  async pairWithDevice(device: AppleTVDevice): Promise<string> {
    try {
      // Use IP if available, otherwise fall back to hostname
      const connectionTarget = device.ip || device.hostname;

      if (!connectionTarget) {
        throw new PairingError(
          'Neither IP address nor hostname available for device',
          'NO_CONNECTION_TARGET',
        );
      }

      this.log.info(
        `Connecting to device ${device.name} at ${connectionTarget}:${device.port}`,
      );
      await this.networkClient.connect(connectionTarget, device.port);
      return await this.pairingProtocol.executePairingFlow(device);
    } catch (error) {
      this.log.error(`Pairing with device ${device.name} failed:`, error);
      throw error;
    } finally {
      this.networkClient.disconnect();
    }
  }
}

// CLI interface
export async function main(): Promise<void> {
  const log = logger.getLogger('AppleTVPairing');

  try {
    const pairingService = new AppleTVPairingService();
    const result = await pairingService.discoverAndPair();

    if (result.success) {
      log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
      process.exit(0);
    } else {
      log.error(`Pairing failed: ${result.error?.message}`);
      process.exit(1);
    }
  } catch (error) {
    log.error('Unexpected error:', error);
    process.exit(1);
  }
}

// eslint-disable-next-line no-console
main().catch(console.error);
