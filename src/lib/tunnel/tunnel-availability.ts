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
import { TunnelAvailabilityError } from './errors.js';
import {
  TunnelApiClient,
  type TunnelApiClientOptions,
  type TunnelEndpoint,
} from './tunnel-api-client.js';

export { TunnelAvailabilityError };

const TUNNEL_REGISTRY_PORT = 'tunnelRegistryPort';

export interface GetTunnelForDeviceOptions {
  /** Long-poll budget passed to GET /tunnels/:udid?waitMs= (0 = immediate). */
  waitMs?: number;
}

/**
 * Resolve tunnel registry metadata for a device (host, RSD port).
 * @throws {TunnelAvailabilityError} When registry or tunnel for the UDID is unavailable.
 */
export async function getTunnelForDevice(
  udid: string,
  options: GetTunnelForDeviceOptions = {},
): Promise<TunnelEndpoint> {
  const client = await createValidatedStrictRegistryClient();
  const waitMs = options.waitMs ?? 0;
  const entry = await client.getTunnelByUdid(udid, { waitMs });

  if (!entry) {
    throw new TunnelAvailabilityError(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first`,
    );
  }

  return mapEntryToEndpoint(entry);
}

/**
 * Returns the list of device UDIDs currently in the tunnel registry.
 * @throws {TunnelAvailabilityError} When the registry port is missing or unreachable.
 */
export async function getAvailableDevices(): Promise<string[]> {
  const client = await createValidatedStrictRegistryClient();
  return await client.getAvailableDevices();
}

/**
 * Strict registry client for internal catalog resolution (service resolver).
 */
export async function createValidatedStrictRegistryClient(): Promise<TunnelApiClient> {
  const port = await readTunnelRegistryPort();
  await assertRegistryPortAcceptingConnections(port);
  return createTunnelRegistryClient(port, {
    strict: true,
    timeoutMs: TUNNEL_REGISTRY_HTTP_TIMEOUT_MS,
  });
}

/** Map a registry entry to a flat tunnel endpoint. */
export function mapEntryToEndpoint(entry: TunnelRegistryEntry): TunnelEndpoint {
  return {
    host: entry.address,
    port: entry.rsdPort,
    udid: entry.udid,
  };
}

/** Whether a registry entry has a non-empty discovered RSD service catalog. */
export function isTunnelEntryReady(entry: TunnelRegistryEntry): boolean {
  return (
    entry.services !== undefined &&
    typeof entry.services === 'object' &&
    Object.keys(entry.services).length > 0
  );
}

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
  const stored = String(tunnelRegistryPort).trim();
  const port = Number.parseInt(stored, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelAvailabilityError(
      `Tunnel registry port "${stored}" is invalid; expected an integer between 1 and 65535`,
    );
  }
  return port;
}

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

function createTunnelRegistryClient(
  port: number,
  options: TunnelApiClientOptions = {},
): TunnelApiClient {
  return new TunnelApiClient(
    `http://${TUNNEL_REGISTRY_HOST}:${port}${TUNNEL_REGISTRY_API_BASE_PATH}`,
    options,
  );
}
