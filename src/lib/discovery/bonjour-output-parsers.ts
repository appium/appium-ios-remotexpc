/**
 * Pure parsers for the line-oriented output of the macOS `dns-sd` CLI.
 *
 * Kept in a separate module so they can be unit-tested without spawning
 * any child processes.
 */
import { stripTrailingDot } from './discovery-utils.js';

const BROWSE_TIMESTAMP = /^\d{2}:\d{2}:\d{2}\.\d+$/;
const BROWSE_FIXED_COLUMNS = 6;
const TXT_PAIR = /(\S+?)=(\S+)/g;
const REACHABLE = /can be reached at (\S+):(\d+)/;

export type BrowseAction = 'Add' | 'Rmv';

export interface BrowsedService {
  name: string;
  serviceType: string;
  domain: string;
}

export interface ParsedBrowseLine {
  action: BrowseAction;
  service: BrowsedService;
}

export interface ParsedReachable {
  hostname: string;
  port: number;
}

/**
 * Parse one `dns-sd -B` output line into an action + service descriptor.
 *
 * Example matched line:
 *   "11:52:30.137  Add        2  17 local. _remotepairing-manual-pairing._tcp. Bedroom"
 *
 * Splits on whitespace rather than relying on a fragile end-to-end regex,
 * since the instance name (last column) may contain spaces (e.g. "Living
 * Room TV").
 */
export function parseBrowseLine(line: string): ParsedBrowseLine | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length <= BROWSE_FIXED_COLUMNS) {
    return null;
  }
  const [timestamp, action, , , domain, serviceType, ...nameParts] = parts;
  if (!BROWSE_TIMESTAMP.test(timestamp)) {
    return null;
  }
  if (action !== 'Add' && action !== 'Rmv') {
    return null;
  }
  const name = nameParts.join(' ').trim();
  if (!name) {
    return null;
  }
  return {
    action,
    service: {
      name,
      serviceType: stripTrailingDot(serviceType),
      domain: stripTrailingDot(domain),
    },
  };
}

/**
 * Parse the `... can be reached at HOST:PORT (...)` line emitted by
 * `dns-sd -L`. Returns null when the line is not a reachability report.
 */
export function parseReachableLine(line: string): ParsedReachable | null {
  const m = line.match(REACHABLE);
  if (!m) {
    return null;
  }
  const port = parseInt(m[2], 10);
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  return { hostname: m[1], port };
}

/**
 * Parse the space-separated `key=value` pairs that follow a `-L` reachable
 * line into a TXT record map. Uses `String.prototype.matchAll` so we never
 * mutate the shared regex's `lastIndex`.
 */
export function parseTxtRecord(line: string): Record<string, string> {
  return Array.from(line.matchAll(TXT_PAIR)).reduce<Record<string, string>>(
    (acc, [, key, value]) => {
      acc[key] = value;
      return acc;
    },
    {},
  );
}
