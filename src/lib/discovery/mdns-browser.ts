import { type Socket, createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { setTimeout } from 'node:timers';

import { getLogger } from '../logger.js';
import {
  MDNS_MCAST_V4,
  MDNS_MCAST_V6,
  MDNS_PORT,
  QTYPE_A,
  QTYPE_AAAA,
  QTYPE_PTR,
  QTYPE_SRV,
  QTYPE_TXT,
  buildQuery,
  buildServiceTypeFqdn,
  parseMdnsMessage,
} from './mdns-protocol.js';

const log = getLogger('MdnsBrowser');

export interface MdnsServiceInstance {
  instance: string;
  host?: string;
  port?: number;
  addresses: string[];
  properties: Record<string, string>;
}

interface MdnsSocketHandle {
  socket: Socket;
  family: 'ipv4' | 'ipv6';
  close(): void;
}

interface SrvEntry {
  target?: string;
  port?: number;
}

/**
 * Browse a DNS-SD service type on the local link (e.g. `_remotepairing._tcp`).
 *
 * Opens raw UDP sockets on port 5353, sends a PTR query, and parses replies
 * without enforcing RFC 6335 service-name length limits.
 */
export async function browseMdnsService(
  serviceType: string,
  domain: string,
  timeoutMs: number,
): Promise<MdnsServiceInstance[]> {
  const serviceTypeFqdn = buildServiceTypeFqdn(serviceType, domain);
  const sockets = await openMdnsSockets();

  const ptrTargets = new Set<string>();
  const srvMap = new Map<string, SrvEntry[]>();
  const txtMap = new Map<string, Record<string, string>>();
  const hostAddresses = new Map<string, string[]>();

  const recordAddress = (hostName: string, ip: string): void => {
    const key = hostName.endsWith('.') ? hostName : `${hostName}.`;
    const existing = hostAddresses.get(key) ?? [];
    if (!existing.includes(ip)) {
      existing.push(ip);
      hostAddresses.set(key, existing);
    }
  };

  try {
    const query = buildQuery(serviceTypeFqdn, QTYPE_PTR, false);
    sendQueryAll(sockets, query);

    await collectResponses(sockets, timeoutMs, (data) => {
      for (const rr of parseMdnsMessage(data)) {
        if (
          rr.type === QTYPE_PTR &&
          rr.name === serviceTypeFqdn &&
          rr.ptrdname
        ) {
          ptrTargets.add(rr.ptrdname);
        } else if (rr.type === QTYPE_SRV && rr.name) {
          addSrvEntry(srvMap, rr.name, {
            target: rr.target,
            port: rr.port,
          });
        } else if (rr.type === QTYPE_TXT && rr.name) {
          txtMap.set(rr.name, rr.txt ?? {});
        } else if (
          (rr.type === QTYPE_A || rr.type === QTYPE_AAAA) &&
          rr.address &&
          rr.name
        ) {
          recordAddress(rr.name, rr.address);
        }
      }
    });
  } finally {
    for (const handle of sockets) {
      handle.close();
    }
  }

  const results: MdnsServiceInstance[] = [];
  for (const instance of [...ptrTargets].sort()) {
    const srvEntries = srvMap.get(instance) ?? [];
    const properties = txtMap.get(instance) ?? {};
    if (srvEntries.length === 0) {
      results.push({
        instance,
        properties,
        addresses: [],
      });
      continue;
    }
    for (const srv of dedupeSrvEntries(srvEntries)) {
      const target = srv.target;
      const host =
        target && target.endsWith('.') ? target.slice(0, -1) : target;
      const addresses = target ? (hostAddresses.get(target) ?? []) : [];
      results.push({
        instance,
        host,
        port: srv.port,
        addresses,
        properties,
      });
    }
  }
  return results;
}

async function openMdnsSockets(): Promise<MdnsSocketHandle[]> {
  const handles: MdnsSocketHandle[] = [];
  const errors: Error[] = [];

  try {
    handles.push(await bindIpv4Socket());
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    handles.push(...(await bindIpv6Sockets()));
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (handles.length === 0) {
    const detail = errors.map((e) => e.message).join('; ');
    throw new Error(
      `Failed to open mDNS sockets on UDP port ${MDNS_PORT}: ${detail}`,
    );
  }
  return handles;
}

function bindIpv4Socket(): Promise<MdnsSocketHandle> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', reject);
    socket.bind(MDNS_PORT, '0.0.0.0', () => {
      socket.removeListener('error', reject);
      try {
        socket.addMembership(MDNS_MCAST_V4, '0.0.0.0');
      } catch (err) {
        log.debug(`IPv4 multicast membership skipped: ${err}`);
      }
      resolve({
        socket,
        family: 'ipv4',
        close: () => socket.close(),
      });
    });
  });
}

async function bindIpv6Sockets(): Promise<MdnsSocketHandle[]> {
  const socket = createSocket({ type: 'udp6', reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(MDNS_PORT, '::', () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
  } catch {
    socket.close();
    return [];
  }

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!isIpv6Interface(entry)) {
        continue;
      }
      try {
        socket.addMembership(MDNS_MCAST_V6, entry.address);
      } catch {
        // interface may not support multicast
      }
    }
  }
  try {
    socket.addMembership(MDNS_MCAST_V6);
  } catch {
    // optional default membership
  }

  return [
    {
      socket,
      family: 'ipv6',
      close: () => socket.close(),
    },
  ];
}

function isIpv6Interface(entry: {
  family: string | number;
  internal?: boolean;
}): boolean {
  return entry.family === 'IPv6' || entry.family === 6;
}

function srvEntryKey(entry: SrvEntry): string {
  return `${entry.target ?? ''}:${entry.port ?? 0}`;
}

function addSrvEntry(
  srvMap: Map<string, SrvEntry[]>,
  instance: string,
  entry: SrvEntry,
): void {
  const entries = srvMap.get(instance) ?? [];
  const key = srvEntryKey(entry);
  if (entries.some((existing) => srvEntryKey(existing) === key)) {
    return;
  }
  entries.push(entry);
  srvMap.set(instance, entries);
}

function dedupeSrvEntries(entries: SrvEntry[]): SrvEntry[] {
  const seen = new Set<string>();
  const unique: SrvEntry[] = [];
  for (const entry of entries) {
    const key = srvEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function sendQueryAll(handles: MdnsSocketHandle[], packet: Buffer): void {
  for (const { socket, family } of handles) {
    if (family !== 'ipv4') {
      continue;
    }
    socket.send(packet, MDNS_PORT, MDNS_MCAST_V4);
  }
}

function collectResponses(
  handles: MdnsSocketHandle[],
  timeoutMs: number,
  onMessage: (data: Buffer) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => onMessage(chunk);
    for (const { socket } of handles) {
      socket.on('message', onData);
    }
    setTimeout(() => {
      for (const { socket } of handles) {
        socket.off('message', onData);
      }
      resolve();
    }, timeoutMs);
  });
}
