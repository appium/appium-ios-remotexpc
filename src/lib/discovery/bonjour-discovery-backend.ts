import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

import { getLogger } from '../logger.js';
import { BaseDiscoveryBackend } from './base-discovery-backend.js';
import { DISCOVERY_DEFAULT_TIMEOUT_MS } from './constants.js';
import { normalizeHostname, resolveIpAddress } from './discovery-utils.js';
import type {
  DiscoveredDevice,
  DiscoveredDeviceMetadata,
  DiscoveryOptions,
} from './types.js';

const log = getLogger('BonjourDiscoveryBackend');

const DNS_SD_BIN = 'dns-sd';
const RESOLVE_TIMEOUT_MS = 3000;

const BROWSE_LINE =
  /^\s*\d{2}:\d{2}:\d{2}\.\d+\s+(Add|Rmv)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(.+)$/;
const REACHABLE = /can be reached at (\S+):(\d+)/;
const TXT_PAIR = /(\S+?)=([^\s]+)/g;

interface BrowsedService {
  name: string;
  serviceType: string;
  domain: string;
}

interface ResolvedService {
  hostname: string;
  port: number;
  txt: Record<string, string>;
}

/**
 * Discovery backend that wraps macOS' built-in `dns-sd` CLI (Apple's Bonjour
 * implementation).
 *
 * Apple's mDNSResponder advertises non-RFC-6335-compliant service names
 * (e.g. `_remotepairing-manual-pairing._tcp`, 28 chars) which strict pure-JS
 * mDNS libraries reject. The system `dns-sd` tool has no such restriction,
 * making it the reliable choice on macOS.
 *
 * Historical note: this module is the spiritual successor to the original
 * `src/lib/bonjour/bonjour-discovery.ts` removed by PR #171 in favor of the
 * cross-platform `dnssd` library; the library turned out to be unable to
 * handle Apple's long service names so the CLI-backed implementation is back.
 */
export class BonjourDiscoveryBackend extends BaseDiscoveryBackend {
  constructor(options?: DiscoveryOptions) {
    super(options);
  }

  protected async runDiscovery(timeoutMs: number): Promise<DiscoveredDevice[]> {
    const browseTimeout = Math.max(timeoutMs, DISCOVERY_DEFAULT_TIMEOUT_MS);
    const services = await browseServices(
      this.serviceType,
      this.domain,
      browseTimeout,
    );
    if (services.length === 0) {
      return [];
    }

    const settled = await Promise.allSettled(
      services.map((svc) => resolveServiceToDevice(svc)),
    );
    return settled
      .filter(
        (item): item is PromiseFulfilledResult<DiscoveredDevice | null> =>
          item.status === 'fulfilled',
      )
      .map((item) => item.value)
      .filter((device): device is DiscoveredDevice => device !== null);
  }
}

/**
 * Run `dns-sd -B` for the configured timeout and return all currently-present
 * services (Add not followed by Rmv).
 *
 * Rejects when the `dns-sd` binary cannot be spawned (e.g. missing from PATH)
 * or when it terminates with a non-zero exit code before we time it out, so
 * callers can distinguish a broken discovery transport from "no devices
 * found".
 */
function browseServices(
  serviceType: string,
  domain: string,
  timeoutMs: number,
): Promise<BrowsedService[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(DNS_SD_BIN, ['-B', serviceType, domain]);
    const services = new Map<string, BrowsedService>();
    let stderr = '';
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      killSafely(child);
      if (spawnError) {
        reject(buildBrowseError(spawnError, stderr));
        return;
      }
      resolve(Array.from(services.values()));
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const parsed = parseBrowseLine(line);
      if (!parsed) {
        return;
      }
      if (parsed.action === 'Add') {
        services.set(parsed.service.name, parsed.service);
      } else if (parsed.action === 'Rmv') {
        services.delete(parsed.service.name);
      }
    });

    child.on('error', (err) => {
      spawnError = err as NodeJS.ErrnoException;
      finish();
    });
    child.on('exit', (code) => {
      // `dns-sd -B` runs forever; we always terminate it via the timer. Only
      // treat exit as a failure when it dies before we asked it to and with a
      // non-zero status (e.g. invalid arguments).
      if (!settled && code !== null && code !== 0) {
        spawnError = Object.assign(new Error(`exited with code ${code}`), {
          code: 'NONZERO_EXIT' as const,
        }) as NodeJS.ErrnoException;
      }
      finish();
    });

    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Build a user-friendly error for `dns-sd -B` failures.
 */
function buildBrowseError(
  spawnError: NodeJS.ErrnoException,
  stderr: string,
): Error {
  const detail = stderr.trim() || spawnError.message;
  const message =
    spawnError.code === 'ENOENT'
      ? `\`dns-sd\` binary not found in PATH: ${detail}`
      : `\`dns-sd\` browse failed: ${detail}`;
  log.warn(message);
  return new Error(message, { cause: spawnError });
}

/**
 * Resolve a discovered service to its host/port/TXT and translate to a
 * `DiscoveredDevice`. Returns null when resolution fails or yields no host.
 */
async function resolveServiceToDevice(
  svc: BrowsedService,
): Promise<DiscoveredDevice | null> {
  const resolved = await runResolve(svc, RESOLVE_TIMEOUT_MS);
  if (!resolved) {
    log.warn(`Failed to resolve service ${svc.name}`);
    return null;
  }
  const hostname = normalizeHostname(resolved.hostname);
  if (!hostname || !resolved.port) {
    return null;
  }
  const ip = await resolveIpAddress(hostname);
  const identifier = resolved.txt.identifier ?? svc.name;
  const metadata: DiscoveredDeviceMetadata = {
    identifier,
    model: resolved.txt.model ?? '',
    version: resolved.txt.ver ?? '',
  };
  return {
    id: identifier,
    name: svc.name,
    hostname,
    ip,
    port: resolved.port,
    metadata,
  };
}

/**
 * Run `dns-sd -L` and return as soon as we have a reachable line + TXT line,
 * or after `timeoutMs`.
 */
function runResolve(
  svc: BrowsedService,
  timeoutMs: number,
): Promise<ResolvedService | null> {
  return new Promise((resolve) => {
    const child = spawn(DNS_SD_BIN, [
      '-L',
      svc.name,
      svc.serviceType,
      svc.domain,
    ]);
    let pending: Pick<ResolvedService, 'hostname' | 'port'> | null = null;
    let settled = false;

    const finish = (result: ResolvedService | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      killSafely(child);
      resolve(result);
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!pending) {
        const m = line.match(REACHABLE);
        if (m) {
          pending = { hostname: m[1], port: parseInt(m[2], 10) };
        }
        return;
      }
      finish({ ...pending, txt: parseTxtRecord(line) });
    });

    child.on('error', () => finish(null));
    child.on('exit', () => finish(pending ? { ...pending, txt: {} } : null));

    const timer = setTimeout(
      () => finish(pending ? { ...pending, txt: {} } : null),
      timeoutMs,
    );
  });
}

/**
 * Parse one `dns-sd -B` output line into an action + service descriptor.
 *
 * Example matched line:
 *   "11:52:30.137  Add        2  17 local.   _remotepairing-manual-pairing._tcp. Bedroom"
 */
function parseBrowseLine(
  line: string,
): { action: 'Add' | 'Rmv'; service: BrowsedService } | null {
  const m = line.match(BROWSE_LINE);
  if (!m) {
    return null;
  }
  const [, action, domain, serviceType, name] = m;
  return {
    action: action as 'Add' | 'Rmv',
    service: {
      name: name.trim(),
      serviceType: stripTrailingDot(serviceType),
      domain: stripTrailingDot(domain),
    },
  };
}

/**
 * Parse the space-separated `key=value` pairs that follow a `-L` reachable line.
 */
function parseTxtRecord(line: string): Record<string, string> {
  const txt: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = TXT_PAIR.exec(line)) !== null) {
    txt[match[1]] = match[2];
  }
  TXT_PAIR.lastIndex = 0;
  return txt;
}

function stripTrailingDot(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function killSafely(child: ChildProcess): void {
  if (!child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // process may have already exited
    }
  }
}
