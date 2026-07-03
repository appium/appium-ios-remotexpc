import type {TunnelRegistryEntry} from '../types.js';
import {TunnelAvailabilityError} from './errors.js';
import type {TunnelEndpoint} from './tunnel-api-client.js';
import {createValidatedStrictRegistryClient, mapEntryToEndpoint} from './tunnel-availability.js';

/** Default long-poll budget when resolving a service at session start. */
export const DEFAULT_TUNNEL_SERVICE_WAIT_MS = 15_000;

export interface ResolveTunnelServiceOptions {
  waitMs?: number;
}

export interface ResolvedTunnelService extends TunnelEndpoint {
  port: number;
}

/**
 * Resolve a service host/port from the registry catalog. Triggers one
 * `refresh-services` round-trip when the service is missing (e.g. post-DDI mount).
 */
export async function resolveTunnelService(
  udid: string,
  serviceName: string,
  options: ResolveTunnelServiceOptions = {},
): Promise<ResolvedTunnelService> {
  const waitMs = options.waitMs ?? DEFAULT_TUNNEL_SERVICE_WAIT_MS;
  const client = await createValidatedStrictRegistryClient();

  let entry = await client.getTunnelByUdid(udid, {waitMs});
  if (!entry) {
    throw new TunnelAvailabilityError(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first`,
    );
  }

  let portStr = getCatalogPort(entry, serviceName);
  if (!portStr) {
    entry = await client.refreshServiceCatalog(udid);
    if (!entry) {
      throw new TunnelAvailabilityError(`Failed to refresh service catalog for device ${udid}`);
    }
    portStr = getCatalogPort(entry, serviceName);
  }

  if (!portStr) {
    throw new TunnelAvailabilityError(
      `Service ${serviceName} not found in tunnel catalog for ${udid}. ` +
        'Ensure Developer Disk Image is mounted if this is a developer service.',
    );
  }

  const endpoint = mapEntryToEndpoint(entry);
  return {
    ...endpoint,
    port: Number.parseInt(portStr, 10),
  };
}

/**
 * Fetch the registry entry (with optional wait) and read multiple service ports.
 * Refreshes the catalog once if any requested service is missing.
 */
export async function resolveTunnelServicePorts(
  udid: string,
  serviceNames: string[],
  options: ResolveTunnelServiceOptions = {},
): Promise<{host: string; ports: Record<string, number>; udid: string}> {
  const waitMs = options.waitMs ?? DEFAULT_TUNNEL_SERVICE_WAIT_MS;
  const client = await createValidatedStrictRegistryClient();

  let entry = await client.getTunnelByUdid(udid, {waitMs});
  if (!entry) {
    throw new TunnelAvailabilityError(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first`,
    );
  }

  const missing = serviceNames.filter((name) => !getCatalogPort(entry, name));
  if (missing.length > 0) {
    entry = await client.refreshServiceCatalog(udid);
    if (!entry) {
      throw new TunnelAvailabilityError(`Failed to refresh service catalog for device ${udid}`);
    }
  }

  const ports: Record<string, number> = {};
  for (const name of serviceNames) {
    const portStr = getCatalogPort(entry, name);
    if (!portStr) {
      throw new TunnelAvailabilityError(`Service ${name} not found in tunnel catalog for ${udid}`);
    }
    ports[name] = Number.parseInt(portStr, 10);
  }

  return {host: entry.address, ports, udid};
}

function getCatalogPort(entry: TunnelRegistryEntry, serviceName: string): string | undefined {
  return entry.services?.[serviceName]?.port;
}
