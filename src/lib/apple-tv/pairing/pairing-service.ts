import type { AppleTVDevice } from '../../bonjour/bonjour-discovery.js';
import { getLogger } from '../../logger.js';
import { DEFAULT_PAIRING_CONFIG } from '../constants.js';
import { DeviceDiscoveryService } from '../discovery/index.js';
import { PairingError } from '../errors.js';
import { NetworkClient } from '../network/index.js';
import { PairingProtocol } from '../pairing-protocol/index.js';
import type { UserInputInterface } from '../pairing-protocol/types.js';
import type { PairingConfig, PairingResult } from '../types.js';

const log = getLogger('AppleTVPairingService');

/** Main service orchestrating Apple TV device discovery and pairing */
export class AppleTVPairingService {
  private readonly networkClient: NetworkClient;
  private readonly discoveryService: DeviceDiscoveryService;
  private readonly userInput: UserInputInterface;
  private readonly pairingProtocol: PairingProtocol;

  constructor(
    userInput: UserInputInterface,
    config: PairingConfig = DEFAULT_PAIRING_CONFIG,
  ) {
    this.networkClient = new NetworkClient(config);
    this.discoveryService = new DeviceDiscoveryService(config);
    this.userInput = userInput;
    this.pairingProtocol = new PairingProtocol(
      this.networkClient,
      this.userInput,
    );
  }

  async discoverAndPair(deviceSelector?: string): Promise<PairingResult> {
    try {
      const devices = await this.discoveryService.discoverDevices();

      if (devices.length === 0) {
        const errorMessage =
          'No Apple TV pairing devices found. Please ensure your Apple TV is on the same network and in pairing mode.';
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

      log.info(
        `Connecting to device ${device.name} at ${connectionTarget}:${device.port}`,
      );
      await this.networkClient.connect(connectionTarget, device.port);
      return await this.pairingProtocol.executePairingFlow(device);
    } catch (error) {
      log.error(`Pairing with device ${device.name} failed:`, error);
      throw error;
    } finally {
      this.networkClient.disconnect();
    }
  }

  private async selectDevice(
    devices: AppleTVDevice[],
    deviceSelector?: string,
  ): Promise<AppleTVDevice> {
    // If no selector provided, always prompt user to choose (even for single device)
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

      // If user just presses Enter and there's only one device, select it
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

    // Try to match by index first
    const indexMatch = parseInt(deviceSelector, 10);
    if (!isNaN(indexMatch) && indexMatch >= 0 && indexMatch < devices.length) {
      log.info(
        `Selected device by index ${indexMatch}: ${devices[indexMatch].name}`,
      );
      return devices[indexMatch];
    }

    // Try to match by name (case-insensitive)
    const nameMatch = devices.find(
      (device) => device.name.toLowerCase() === deviceSelector.toLowerCase(),
    );
    if (nameMatch) {
      log.info(
        `Selected device by name: ${nameMatch.name} (${nameMatch.identifier})`,
      );
      return nameMatch;
    }

    // Try to match by identifier (case-insensitive)
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

    // No match found
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
