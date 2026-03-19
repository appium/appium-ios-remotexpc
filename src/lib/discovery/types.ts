export interface DiscoveredDevice {
  id: string;
  name: string;
  hostname?: string;
  ip?: string;
  port?: number;
  source: 'dnssd' | 'devicectl';
  metadata: Record<string, string | number | boolean | undefined>;
}

export interface DiscoveryOptions {
  serviceType: string;
  domain?: string;
}

export interface IDeviceDiscoveryBackend {
  discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]>;
}
