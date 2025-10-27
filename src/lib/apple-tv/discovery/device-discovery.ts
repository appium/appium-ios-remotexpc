import { logger } from '@appium/support';

import {
  type AppleTVDevice,
  BonjourDiscovery,
} from '../../bonjour/bonjour-discovery.js';
import { PairingError } from '../errors.js';
import type { PairingConfig } from '../types.js';

/** Discovers Apple TV devices on the local network using Bonjour */
export class DeviceDiscoveryService {
  private readonly log = logger.getLogger('DeviceDiscoveryService');

  constructor(private readonly config: PairingConfig) {}

  async discoverDevices(): Promise<AppleTVDevice[]> {
    try {
      const discovery = new BonjourDiscovery();
      this.log.info(
        `Discovering Apple TV devices (waiting ${this.config.discoveryTimeout / 1000} seconds)...`,
      );
      return await discovery.discoverAppleTVDevicesWithIP(
        this.config.discoveryTimeout,
      );
    } catch (error) {
      this.log.error('Device discovery failed:', error);
      throw new PairingError(
        'Device discovery failed',
        'DISCOVERY_ERROR',
        error,
      );
    }
  }
}
