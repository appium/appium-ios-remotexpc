import { getLogger } from '../logger.js';
import { RemoteXpcConnection } from '../remote-xpc/remote-xpc-connection.js';
import type { Service } from '../remote-xpc/service-catalog.js';
import type { TunnelServiceCatalog } from '../types.js';

const log = getLogger('TunnelRsdDiscovery');

const inFlightByUdid = new Map<string, Promise<Service[]>>();

/**
 * Open RSD, read the service catalog, and close. Concurrent calls for the same
 * UDID coalesce into one in-flight discover (singleflight).
 */
export async function discoverServices(
  udid: string,
  address: string,
  rsdPort: number,
): Promise<Service[]> {
  const existing = inFlightByUdid.get(udid);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      return await discoverServicesOnce(address, rsdPort);
    } finally {
      inFlightByUdid.delete(udid);
    }
  })();
  inFlightByUdid.set(udid, promise);
  return promise;
}

/** Serialize RSD handshake services into registry catalog shape. */
export function servicesToCatalog(services: Service[]): TunnelServiceCatalog {
  return Object.fromEntries(
    services.map((service) => [service.serviceName, { port: service.port }]),
  );
}

async function discoverServicesOnce(
  address: string,
  rsdPort: number,
): Promise<Service[]> {
  const remoteXPC = new RemoteXpcConnection([address, rsdPort]);
  try {
    await remoteXPC.connect();
    return remoteXPC.getServices();
  } finally {
    try {
      await remoteXPC.close();
    } catch (err) {
      log.warn(
        `RSD discovery close failed for ${address}:${rsdPort}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
