#!/usr/bin/env tsx
import { logger } from '@appium/support';
import { createInterface } from 'node:readline';

import {
  DEFAULT_PAIRING_CONFIG,
  DeviceDiscoveryService,
  NetworkClient,
  PairingError,
  PairingProtocol,
  type PairingConfig,
  type PairingResult,
  type UserInputInterface,
} from '../src/lib/apple-tv/index.js';
import type { AppleTVDevice } from '../src/lib/bonjour/bonjour-discovery.js';

const PIN_INPUT_TIMEOUT_MS = 120000;

/** Handles user interaction for PIN input during pairing */
export class UserInputService implements UserInputInterface {
  private readonly log = logger.getLogger('UserInputService');

  async promptForPIN(): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let timeoutId: NodeJS.Timeout | null = null;

    try {
      const questionPromise = new Promise<string>((resolve) => {
        rl.question('Enter PIN from Apple TV screen: ', (answer) => {
          resolve(answer);
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new PairingError('PIN input timeout', 'INPUT_TIMEOUT'));
        }, PIN_INPUT_TIMEOUT_MS);
      });

      const pin = await Promise.race([questionPromise, timeoutPromise]);

      // Clear timeout since we got the PIN
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const cleanPin = pin.trim();
      if (!cleanPin.length || !/^\d+$/.test(cleanPin)) {
        this.log.error('Invalid PIN format');
        throw new PairingError('PIN must contain only digits', 'INVALID_PIN');
      }

      this.log.debug('PIN received successfully');
      return cleanPin;
    } finally {
      // Clean up timeout if error occurred before clearing
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      rl.close();
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
    this.pairingProtocol = new PairingProtocol(this.networkClient, this.userInput);
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
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async pairWithDevice(device: AppleTVDevice): Promise<string> {
    try {
      // Use IP if available, otherwise fall back to hostname
      const connectionTarget = device.ip ?? device.hostname;

      if (!connectionTarget) {
        throw new PairingError(
          'Neither IP address nor hostname available for device',
          'NO_CONNECTION_TARGET',
        );
      }

      this.log.info(`Connecting to device ${device.name} at ${connectionTarget}:${device.port}`);
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
    } else {
      log.error(`Pairing failed: ${result.error?.message}`);
    }
  } catch (error) {
    log.error('Unexpected error:', error);
  }
}

// eslint-disable-next-line no-console
main().catch(console.error);
