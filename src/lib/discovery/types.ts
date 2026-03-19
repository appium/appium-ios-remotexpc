export type DiscoverySource = 'dnssd' | 'devicectl';

export interface DnssdDiscoveryMetadata {
  identifier?: string;
  model?: string;
  version?: string;
  minVersion?: string;
  authTag?: string;
  serviceType: string;
}

export interface DevicectlDiscoveryMetadata {
  identifier: string;
  model?: string;
  version?: string;
  deviceType?: string;
  port?: number;
}

export interface DiscoveryMetadataBySource {
  dnssd: DnssdDiscoveryMetadata;
  devicectl: DevicectlDiscoveryMetadata;
}

export interface DiscoveredDevice<
  TSource extends DiscoverySource = DiscoverySource,
> {
  id: string;
  name: string;
  hostname?: string;
  ip?: string;
  port?: number;
  source: TSource;
  metadata: DiscoveryMetadataBySource[TSource];
}

export type AnyDiscoveredDevice = {
  [TSource in DiscoverySource]: DiscoveredDevice<TSource>;
}[DiscoverySource];

export type DiscoveredDeviceFor<TSource extends DiscoverySource> =
  TSource extends DiscoverySource ? DiscoveredDevice<TSource> : never;

export interface DiscoveryOptions {
  serviceType: string;
  domain?: string;
}

export interface IDeviceDiscoveryBackend<
  TSource extends DiscoverySource = DiscoverySource,
> {
  discoverDevices(timeoutMs: number): Promise<DiscoveredDeviceFor<TSource>[]>;
}
