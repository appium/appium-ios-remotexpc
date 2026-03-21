export interface DiscoveredDeviceMetadata {
  identifier?: string;
  model?: string;
  version?: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  minVersion?: string;
  deviceType?: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  authTag?: string;
  /** @deprecated Retained for backward compatibility; not actively used. */
  serviceType?: string;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  hostname?: string;
  ip?: string;
  port?: number;
  metadata: DiscoveredDeviceMetadata;
}

export interface DiscoveryOptions {
  serviceType: string;
  domain?: string;
}

export interface IDeviceDiscoveryBackend {
  discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]>;
}
