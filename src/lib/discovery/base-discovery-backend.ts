import {
  DISCOVERY_DEFAULT_DOMAIN,
  DISCOVERY_DEFAULT_SERVICE_TYPE,
} from './constants.js';
import type {
  DiscoveredDevice,
  DiscoveryOptions,
  IDeviceDiscoveryBackend,
} from './types.js';

/**
 * Common scaffolding for discovery backends.
 *
 * Centralizes the in-flight deduplication so concurrent `discoverDevices`
 * calls share a single underlying browse, and provides default options.
 * Concrete backends only implement `runDiscovery`.
 */
export abstract class BaseDiscoveryBackend implements IDeviceDiscoveryBackend {
  private inFlightDiscovery?: Promise<DiscoveredDevice[]>;

  protected constructor(
    protected readonly options: DiscoveryOptions = {
      serviceType: DISCOVERY_DEFAULT_SERVICE_TYPE,
      domain: DISCOVERY_DEFAULT_DOMAIN,
    },
  ) {}

  async discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]> {
    if (this.inFlightDiscovery) {
      return await this.inFlightDiscovery;
    }
    this.inFlightDiscovery = this.runDiscovery(timeoutMs);
    try {
      return await this.inFlightDiscovery;
    } finally {
      this.inFlightDiscovery = undefined;
    }
  }

  protected get serviceType(): string {
    return this.options.serviceType || DISCOVERY_DEFAULT_SERVICE_TYPE;
  }

  protected get domain(): string {
    return this.options.domain || DISCOVERY_DEFAULT_DOMAIN;
  }

  protected abstract runDiscovery(
    timeoutMs: number,
  ): Promise<DiscoveredDevice[]>;
}
