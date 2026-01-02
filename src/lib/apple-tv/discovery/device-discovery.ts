import {
  type AppleTVDevice,
  BonjourDiscovery,
} from '../../bonjour/bonjour-discovery.js';
import { getLogger } from '../../logger.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';

const log = getLogger('DeviceDiscoveryService');

/** Discovers Apple TV devices on the local network using Bonjour */
export class DeviceDiscoveryService {
  constructor(private readonly config: PairingConfig) {}

  async discoverDevices(): Promise<AppleTVDevice[]> {
    try {
      const discovery = new BonjourDiscovery();
      log.info(
        `Discovering Apple TV devices (waiting ${this.config.discoveryTimeout / 1000} seconds)...`,
      );
      return await discovery.discoverAppleTVDevicesWithIP(
        this.config.discoveryTimeout,
      );
    } catch (error) {
      log.error('Device discovery failed:', error);
      throw new PairingError(
        'Device discovery failed',
        'DISCOVERY_ERROR',
        error,
      );
    }
  }
}
