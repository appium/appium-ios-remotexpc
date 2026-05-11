import { lookup } from 'node:dns/promises';

/**
 * Ensure hostnames are returned in fqdn form with trailing dot.
 */
export function normalizeHostname(host?: string): string | undefined {
  if (!host) {
    return undefined;
  }
  return host.endsWith('.') ? host : `${host}.`;
}

/**
 * Resolve a preferred IPv4 address from service data or DNS lookup.
 */
export async function resolveIpAddress(
  host?: string,
  addresses?: string[],
): Promise<string | undefined> {
  if (addresses?.[0]) {
    return addresses[0];
  }
  if (!host) {
    return undefined;
  }
  try {
    const results = await lookup(host.replace(/\.$/, ''), {
      family: 4,
      all: true,
    });
    return results[0]?.address;
  } catch {
    return undefined;
  }
}
