import { fs } from '@appium/support';
import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

import { getLogger } from '../logger.js';
import { BaseDiscoveryBackend } from './base-discovery-backend.js';
import {
  type BrowsedService,
  parseBrowseLine,
  parseReachableLine,
  parseTxtRecord,
} from './bonjour-output-parsers.js';
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

interface ResolvedService {
  hostname: string;
  port: number;
  txt: Record<string, string>;
}

interface DnsSdHandlers<T> {
  /**
   * Called for each stdout line. Return `{ result }` to settle the promise
   * with that value, `{ error }` to reject, or `undefined` to keep reading.
   */
  onLine: (line: string) => { result: T } | { error: Error } | undefined;
  /**
   * Called when the child fails to spawn or emits `error`. Return either an
   * `Error` to reject with, or a `{ result }` to settle with.
   */
  onSpawnError: (
    err: NodeJS.ErrnoException,
    stderr: string,
  ) => Error | { result: T };
  /** Called when the child exits before any other settlement. */
  onExit: (
    code: number | null,
    stderr: string,
  ) => { result: T } | { error: Error };
  /** Called when the timeout fires before any other settlement. */
  onTimeout: () => { result: T } | { error: Error };
  /** Capture stderr into the buffer passed to `onSpawnError`/`onExit`. */
  captureStderr?: boolean;
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

  protected override async runDiscovery(
    timeoutMs: number,
  ): Promise<DiscoveredDevice[]> {
    await assertDnsSdAvailable();
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
 * Verify that the `dns-sd` binary is reachable on PATH and surface a
 * descriptive error otherwise (e.g. running on a non-darwin host without
 * Apple's Bonjour CLI installed).
 */
async function assertDnsSdAvailable(): Promise<void> {
  try {
    await fs.which(DNS_SD_BIN);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `\`${DNS_SD_BIN}\` binary not found in PATH: ${detail}`;
    log.warn(message);
    throw new Error(message, { cause: err });
  }
}

/**
 * Run `dns-sd -B` for the configured timeout and return all currently-present
 * services (Add not followed by Rmv).
 *
 * Rejects when `dns-sd` cannot be spawned (e.g. missing from PATH) or when
 * it terminates with a non-zero exit code before we time it out, so callers
 * can distinguish a broken discovery transport from "no devices found".
 */
async function browseServices(
  serviceType: string,
  domain: string,
  timeoutMs: number,
): Promise<BrowsedService[]> {
  const services = new Map<string, BrowsedService>();
  return await runDnsSd<BrowsedService[]>(
    ['-B', serviceType, domain],
    timeoutMs,
    {
      captureStderr: true,
      onLine: (line) => {
        const parsed = parseBrowseLine(line);
        if (!parsed) {
          return undefined;
        }
        if (parsed.action === 'Add') {
          services.set(parsed.service.name, parsed.service);
        } else {
          services.delete(parsed.service.name);
        }
        return undefined;
      },
      onSpawnError: (err, stderr) => buildBrowseError(err, stderr),
      onExit: (code, stderr) => {
        // `dns-sd -B` runs forever; we always terminate it via the timer. Only
        // treat exit as a failure when it dies before we asked it to and with a
        // non-zero status (e.g. invalid arguments).
        if (code !== null && code !== 0) {
          const err = Object.assign(new Error(`exited with code ${code}`), {
            code: 'NONZERO_EXIT' as const,
          }) as NodeJS.ErrnoException;
          return { error: buildBrowseError(err, stderr) };
        }
        return { result: Array.from(services.values()) };
      },
      onTimeout: () => ({ result: Array.from(services.values()) }),
    },
  );
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
      ? `\`${DNS_SD_BIN}\` binary not found in PATH: ${detail}`
      : `\`${DNS_SD_BIN}\` browse failed: ${detail}`;
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
async function runResolve(
  svc: BrowsedService,
  timeoutMs: number,
): Promise<ResolvedService | null> {
  let pending: Pick<ResolvedService, 'hostname' | 'port'> | null = null;
  const fromPending = (): ResolvedService | null =>
    pending ? { ...pending, txt: {} } : null;

  return await runDnsSd<ResolvedService | null>(
    ['-L', svc.name, svc.serviceType, svc.domain],
    timeoutMs,
    {
      onLine: (line) => {
        if (!pending) {
          const reachable = parseReachableLine(line);
          if (reachable) {
            pending = reachable;
          }
          return undefined;
        }
        return { result: { ...pending, txt: parseTxtRecord(line) } };
      },
      onSpawnError: () => ({ result: null }),
      onExit: () => ({ result: fromPending() }),
      onTimeout: () => ({ result: fromPending() }),
    },
  );
}

/**
 * Spawn `dns-sd` with the given arguments and drive the readline / timeout /
 * cleanup lifecycle. Behavior is fully delegated to the supplied handlers so
 * callers can build different state machines (browse aggregation, single-shot
 * resolve, etc.) on top of the same plumbing.
 */
async function runDnsSd<T>(
  args: string[],
  timeoutMs: number,
  handlers: DnsSdHandlers<T>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(DNS_SD_BIN, args);
    let stderr = '';
    let settled = false;

    const settle = (outcome: { result: T } | { error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      killSafely(child);
      if ('error' in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.result);
      }
    };

    if (handlers.captureStderr) {
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const outcome = handlers.onLine(line);
      if (outcome) {
        settle(outcome);
      }
    });

    child.on('error', (err) => {
      const outcome = handlers.onSpawnError(
        err as NodeJS.ErrnoException,
        stderr,
      );
      settle(outcome instanceof Error ? { error: outcome } : outcome);
    });
    child.on('exit', (code) => settle(handlers.onExit(code, stderr)));

    const timer = setTimeout(() => settle(handlers.onTimeout()), timeoutMs);
  });
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
