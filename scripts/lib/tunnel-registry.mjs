import {discoverServices, servicesToCatalog} from 'appium-ios-remotexpc';

/**
 * @returns {import('appium-ios-remotexpc').TunnelRegistry}
 */
export function createEmptyTunnelRegistry() {
  return {
    tunnels: {},
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalTunnels: 0,
      activeTunnels: 0,
    },
  };
}

/**
 * @param {string} udid
 * @param {import('appium-ios-remotexpc').TunnelRegistryEntry} entry
 * @param {{info: (message: string) => void}} log
 */
export async function refreshServiceCatalog(udid, entry, log) {
  log.info(`Refreshing RSD service catalog for ${udid}...`);
  const services = await discoverServices(udid, entry.address, entry.rsdPort);
  const now = Date.now();
  return {
    ...entry,
    services: servicesToCatalog(services),
    catalogUpdatedAt: now,
    lastUpdated: now,
  };
}

/**
 * @template T
 * @param {object} opts
 * @param {import('appium-ios-remotexpc').TunnelRegistryServer | null} opts.registryServer
 * @param {T & { tunnel: { Address: string, RsdPort?: number } }} opts.result
 * @param {(result: T) => string} opts.getUdid
 * @param {(result: T, existing: import('appium-ios-remotexpc').TunnelRegistryEntry | undefined, now: number) => import('appium-ios-remotexpc').TunnelRegistryEntry} opts.buildEntry
 * @param {{info: (message: string) => void, warn: (message: string) => void}} opts.log
 * @returns {Promise<boolean>}
 */
export async function publishDiscoveredTunnelEntry({registryServer, result, getUdid, buildEntry, log}) {
  if (!registryServer) {
    throw new Error('Registry server is not started');
  }

  const udid = getUdid(result);
  const rsdPort = result.tunnel.RsdPort;
  if (typeof rsdPort !== 'number' || rsdPort <= 0) {
    log.warn(`Skipping registry entry for ${udid}: no valid RSD port (got ${String(rsdPort)})`);
    return false;
  }

  registryServer.markTunnelPending(udid);
  log.info(`Discovering RSD services for ${udid} at ${result.tunnel.Address}:${rsdPort}...`);

  const services = await discoverServices(udid, result.tunnel.Address, rsdPort);
  const now = Date.now();
  const registry = registryServer.getRegistry();
  const entry = buildEntry(result, registry.tunnels[udid], now);
  entry.services = servicesToCatalog(services);
  entry.catalogUpdatedAt = now;

  registryServer.upsertReadyEntry(udid, entry);
  log.info(`Published tunnel catalog for ${udid} (${Object.keys(entry.services).length} services)`);
  return true;
}
