import { createDiscoveryBackend } from '../../discovery/index.js';
import { getLogger } from '../../logger.js';
import {
  DEFAULT_PAIRING_CONFIG,
  REMOTE_PAIRING_DISCOVERY_DOMAIN,
  REMOTE_PAIRING_DISCOVERY_SERVICE_TYPE,
} from '../constants.js';
import { enrichDiscoveredDevicesWithDevicectl } from '../devicectl-enrichment.js';
import { toRemotePairingDevices } from '../discovered-device-mapper.js';
import { NetworkError, PairingError } from '../errors.js';
import { NetworkClient } from '../network/index.js';
import { PairingProtocol } from '../pairing-protocol/index.js';
import type { UserInputInterface } from '../pairing-protocol/types.js';
import type {
  PairingConfig,
  RemotePairingDevice,
  RemotePairingResult,
} from '../types.js';

const log = getLogger('RemotePairingService');

/** Discovers `_remotepairing._tcp` devices and runs Pair-Setup (iOS, iPadOS, tvOS, …). */
export class RemotePairingService {
  private readonly networkClient: NetworkClient;
  private readonly config: PairingConfig;
  private readonly userInput: UserInputInterface;
  private readonly pairingProtocol: PairingProtocol;

  constructor(
    userInput: UserInputInterface,
    config: PairingConfig = DEFAULT_PAIRING_CONFIG,
  ) {
    this.config = config;
    this.networkClient = new NetworkClient(config);
    this.userInput = userInput;
    this.pairingProtocol = new PairingProtocol(
      this.networkClient,
      this.userInput,
    );
  }

  async discoverAndPair(deviceSelector?: string): Promise<RemotePairingResult> {
    try {
      const devices = await this.discoverDevices();

      if (devices.length === 0) {
        const errorMessage =
          'No Remote Pairing devices found. Ensure the device is on the same network, awake, and advertising _remotepairing._tcp (Wi‑Fi remote pairing).';
        log.error(errorMessage);
        throw new PairingError(errorMessage, 'NO_DEVICES');
      }

      const device = await this.selectDevice(devices, deviceSelector);
      const pairingFile = await this.pairWithDevice(device);

      return {
        success: true,
        deviceId: device.identifier,
        pairingFile,
      };
    } catch (error) {
      log.error('Pairing failed:', error);
      return {
        success: false,
        deviceId: 'unknown',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async pairWithDevice(device: RemotePairingDevice): Promise<string> {
    const connectionTarget = device.ip ?? device.hostname;

    if (!connectionTarget) {
      throw new PairingError(
        'Neither IP address nor hostname available for device',
        'NO_CONNECTION_TARGET',
      );
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        log.info(
          `Connecting to ${device.name} at ${connectionTarget}:${device.port}`,
        );
        await this.networkClient.connect(connectionTarget, device.port);
        return await this.pairingProtocol.executePairingFlow(device);
      } catch (error) {
        const transient =
          attempt < maxAttempts && this.isTransientPairingNetworkError(error);
        if (transient) {
          log.warn(
            `Pairing transient error (attempt ${attempt}/${maxAttempts}), retrying after delay…`,
            error,
          );
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        log.error(`Pairing with device ${device.name} failed:`, error);
        throw error;
      } finally {
        this.networkClient.disconnect();
      }
    }

    throw new PairingError(
      'Pairing failed after retries',
      'PAIRING_RETRY_EXHAUSTED',
    );
  }

  private isTransientPairingNetworkError(error: unknown): boolean {
    if (error instanceof NetworkError) {
      const m = error.message.toLowerCase();
      return (
        m.includes('econnreset') ||
        m.includes('econnrefused') ||
        m.includes('socket') ||
        m.includes('closed') ||
        m.includes('timeout')
      );
    }
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String((error as NodeJS.ErrnoException).code ?? '');
      return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code);
    }
    return false;
  }

  private async discoverDevices(): Promise<RemotePairingDevice[]> {
    try {
      const backend = createDiscoveryBackend(process.platform, {
        serviceType: REMOTE_PAIRING_DISCOVERY_SERVICE_TYPE,
        domain: REMOTE_PAIRING_DISCOVERY_DOMAIN,
      });
      log.info(
        `Discovering Remote Pairing devices (waiting ${this.config.discoveryTimeout / 1000} seconds)...`,
      );
      const discoveredDevices = await backend.discoverDevices(
        this.config.discoveryTimeout,
      );
      const enrichedDevices =
        await enrichDiscoveredDevicesWithDevicectl(discoveredDevices);
      return toRemotePairingDevices(enrichedDevices);
    } catch (error) {
      log.error('Device discovery failed:', error);
      throw new PairingError(
        'Device discovery failed',
        'DISCOVERY_ERROR',
        error,
      );
    }
  }

  private async selectDevice(
    devices: RemotePairingDevice[],
    deviceSelector?: string,
  ): Promise<RemotePairingDevice> {
    if (!deviceSelector) {
      log.info(`Found ${devices.length} device(s):`);
      devices.forEach((device, index) => {
        log.info(
          `  [${index}] ${device.name} (${device.identifier}) - ${device.model} v${device.version}`,
        );
      });

      const prompt =
        devices.length === 1
          ? 'Press Enter to select device [0], or enter index: '
          : `Select device by index (0-${devices.length - 1}): `;

      const indexStr = await this.userInput.promptForInput(prompt);
      const trimmed = indexStr.trim();

      if (trimmed === '' && devices.length === 1) {
        log.info(
          `Selected device: ${devices[0].name} (${devices[0].identifier})`,
        );
        return devices[0];
      }

      const index = parseInt(trimmed, 10);

      if (isNaN(index) || index < 0 || index >= devices.length) {
        throw new PairingError(
          `Invalid device index: ${trimmed}. Must be between 0 and ${devices.length - 1}`,
          'INVALID_DEVICE_SELECTION',
        );
      }

      log.info(
        `Selected device: ${devices[index].name} (${devices[index].identifier})`,
      );
      return devices[index];
    }

    const indexMatch = parseInt(deviceSelector, 10);
    if (!isNaN(indexMatch) && indexMatch >= 0 && indexMatch < devices.length) {
      log.info(
        `Selected device by index ${indexMatch}: ${devices[indexMatch].name}`,
      );
      return devices[indexMatch];
    }

    const nameMatch = devices.find(
      (device) => device.name.toLowerCase() === deviceSelector.toLowerCase(),
    );
    if (nameMatch) {
      log.info(
        `Selected device by name: ${nameMatch.name} (${nameMatch.identifier})`,
      );
      return nameMatch;
    }

    const identifierMatch = devices.find(
      (device) =>
        device.identifier.toLowerCase() === deviceSelector.toLowerCase(),
    );
    if (identifierMatch) {
      log.info(
        `Selected device by identifier: ${identifierMatch.name} (${identifierMatch.identifier})`,
      );
      return identifierMatch;
    }

    const availableDevices = devices
      .map(
        (device, index) => `  [${index}] ${device.name} (${device.identifier})`,
      )
      .join('\n');

    throw new PairingError(
      `Device '${deviceSelector}' not found. Available devices:\n${availableDevices}`,
      'DEVICE_NOT_FOUND',
    );
  }
}
