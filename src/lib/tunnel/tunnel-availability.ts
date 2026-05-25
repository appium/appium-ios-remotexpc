import { BaseItem, strongbox } from '@appium/strongbox';
import * as net from 'node:net';

import { TUNNEL_CONTAINER_NAME } from '../../constants.js';
import type { TunnelRegistryEntry } from '../types.js';
import {
  TUNNEL_REGISTRY_API_BASE_PATH,
  TUNNEL_REGISTRY_HOST,
  TUNNEL_REGISTRY_HTTP_TIMEOUT_MS,
  TUNNEL_REGISTRY_PORT_PROBE_TIMEOUT_MS,
} from './constants.js';
import {
  TunnelApiClient,
  type TunnelApiClientOptions,
  type TunnelEndpoint,
} from './tunnel-api-client.js';

const TUNNEL_REGISTRY_PORT = 'tunnelRegistryPort';

export class TunnelAvailabilityError extends Error {
  readonly code = 'ERR_TUNNEL_AVAILABILITY';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Resolve tunnel registry metadata for a device (host, RSD port, packet stream).
 * Strongbox port, TCP probe, then a single `GET /remotexpc/tunnels/{udid}`.
 * @throws {TunnelAvailabilityError} When registry or tunnel for the UDID is unavailable.
 */
export async function getTunnelForDevice(
  udid: string,
): Promise<TunnelEndpoint> {
  const client = await createValidatedStrictRegistryClient();

  let entry: TunnelRegistryEntry | null;
  try {
    entry = await client.getTunnelByUdid(udid);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TunnelAvailabilityError(
      `Failed to reach tunnel registry: ${detail}`,
      { cause: err },
    );
  }

  if (!entry) {
    throw new TunnelAvailabilityError(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first`,
    );
  }

  return mapEntryToEndpoint(entry);
}

/**
 * Returns the list of device UDIDs currently in the tunnel registry.
 * Used to include tunnel-only devices (e.g. Apple TV over WiFi)
 * in the "connected devices" list for session validation.
 *
 * @returns UDIDs when the registry is reachable (possibly empty).
 * @throws {TunnelAvailabilityError} When the registry port is missing or unreachable.
 */
export async function getAvailableDevices(): Promise<string[]> {
  const client = await createValidatedStrictRegistryClient();
  try {
    return await client.getAvailableDevices();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new TunnelAvailabilityError(
      `Failed to reach tunnel registry: ${detail}`,
      { cause: err },
    );
  }
}

/**
 * Read the tunnel registry HTTP port from strongbox.
 * @throws {TunnelAvailabilityError} When the port was never stored (tunnel-creation not run).
 */
async function readTunnelRegistryPort(): Promise<number> {
  const box = strongbox(TUNNEL_CONTAINER_NAME);
  const item = new BaseItem(TUNNEL_REGISTRY_PORT, box);
  const tunnelRegistryPort = await item.read();
  if (
    tunnelRegistryPort === undefined ||
    String(tunnelRegistryPort).trim() === ''
  ) {
    throw new TunnelAvailabilityError(
      'Tunnel registry port not found. Please run the tunnel creation script first',
    );
  }
  return Number.parseInt(String(tunnelRegistryPort), 10);
}

/**
 * Verify the registry HTTP server is accepting TCP connections on localhost.
 * @throws {TunnelAvailabilityError} When the port is closed or the probe times out.
 */
async function assertRegistryPortAcceptingConnections(
  port: number,
): Promise<void> {
  const registryAddress = `${TUNNEL_REGISTRY_HOST}:${port}`;
  const unreachableMessage = `Tunnel registry at ${registryAddress} is not reachable. Please run the tunnel creation script first`;

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: TUNNEL_REGISTRY_HOST, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TunnelAvailabilityError(unreachableMessage));
    }, TUNNEL_REGISTRY_PORT_PROBE_TIMEOUT_MS);

    const finish = (err?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    socket.once('connect', () => finish());
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        finish(new TunnelAvailabilityError(unreachableMessage, { cause: err }));
        return;
      }
      finish(
        new TunnelAvailabilityError(
          `Tunnel registry port probe failed for ${registryAddress}: ${err.message}`,
          { cause: err },
        ),
      );
    });
  });
}

/** Map a registry entry to a flat tunnel endpoint for RSD connect. */
function mapEntryToEndpoint(entry: TunnelRegistryEntry): TunnelEndpoint {
  return {
    host: entry.address,
    port: entry.rsdPort,
    udid: entry.udid,
    packetStreamPort: entry.packetStreamPort,
  };
}

/**
 * Build a strict tunnel registry API client (caller supplies port via base URL).
 */
function createTunnelRegistryClient(
  port: number,
  options: TunnelApiClientOptions = {},
): TunnelApiClient {
  return new TunnelApiClient(
    `http://${TUNNEL_REGISTRY_HOST}:${port}${TUNNEL_REGISTRY_API_BASE_PATH}`,
    options,
  );
}

/** Strongbox port, TCP probe, then a strict registry client with the lookup timeout. */
async function createValidatedStrictRegistryClient(): Promise<TunnelApiClient> {
  const port = await readTunnelRegistryPort();
  await assertRegistryPortAcceptingConnections(port);
  return createTunnelRegistryClient(port, {
    strict: true,
    timeoutMs: TUNNEL_REGISTRY_HTTP_TIMEOUT_MS,
  });
}
