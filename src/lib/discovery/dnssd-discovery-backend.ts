import * as dnssd from 'dnssd';
import type { Service } from 'dnssd';
import { setTimeout as delay } from 'node:timers/promises';

import { getLogger } from '../logger.js';
import { BaseDiscoveryBackend } from './base-discovery-backend.js';
import { DISCOVERY_DEFAULT_TIMEOUT_MS } from './constants.js';
import { normalizeHostname, resolveIpAddress } from './discovery-utils.js';
import type {
  DiscoveredDevice,
  DiscoveredDeviceMetadata,
  DiscoveryOptions,
} from './types.js';

const log = getLogger('DnssdDiscoveryBackend');

/**
 * Cross-platform discovery backend using the `dnssd` npm library.
 *
 * Note: `dnssd` enforces RFC 6335 (max 15-char service names), so it cannot
 * see Apple's long names like `_remotepairing-manual-pairing._tcp`. Use
 * `BonjourDiscoveryBackend` on darwin for those.
 */
export class DnssdDiscoveryBackend extends BaseDiscoveryBackend {
  constructor(options?: DiscoveryOptions) {
    super(options);
  }

  protected override async runDiscovery(
    timeoutMs: number,
  ): Promise<DiscoveredDevice[]> {
    const browser = new dnssd.Browser(this.serviceType, {
      domain: this.domain,
    });
    const devices = new Map<string, Promise<DiscoveredDevice | null>>();
    let browserError: Error | null = null;

    browser.on('serviceUp', (service: Service) => {
      const hostname = normalizeHostname(service.host);
      if (!hostname || !service.port) {
        return;
      }
      const key = `${service.name ?? hostname}:${hostname}:${service.port}`;
      devices.set(key, resolveDiscoveredDevice(service, hostname));
    });

    browser.on('error', (err: Error) => {
      const message = formatDnssdBrowserErrorMessage(err);
      browserError = new Error(message, { cause: err });
      log.warn(`dnssd browser error: ${message}`);
    });

    browser.start();
    try {
      await delay(Math.max(timeoutMs, DISCOVERY_DEFAULT_TIMEOUT_MS));
      if (browserError) {
        throw browserError;
      }
      if (devices.size === 0) {
        return [];
      }
      const resolvedDevices = await Promise.allSettled(devices.values());
      return resolvedDevices
        .filter(
          (item): item is PromiseFulfilledResult<DiscoveredDevice | null> =>
            item.status === 'fulfilled',
        )
        .map((item) => item.value)
        .filter((device): device is DiscoveredDevice => device !== null);
    } finally {
      browser.stop();
    }
  }
}

/**
 * Convert a discovered dnssd service entry into a normalized device model.
 */
async function resolveDiscoveredDevice(
  service: Service,
  hostname: string,
): Promise<DiscoveredDevice | null> {
  try {
    if (!service.port) {
      return null;
    }
    const txt = service.txt ?? {};
    const ip = await resolveIpAddress(hostname, service.addresses);
    const identifier = txt.identifier ?? service.name ?? hostname;
    const metadata: DiscoveredDeviceMetadata = {
      identifier,
      model: txt.model ?? '',
      version: txt.ver ?? '',
    };
    return {
      id: identifier,
      name: service.name ?? identifier,
      hostname,
      ip,
      port: service.port,
      metadata,
    };
  } catch (err) {
    log.warn(`Failed to process dnssd service: ${err}`);
    return null;
  }
}

/**
 * Format a user-facing dnssd browser error with root privilege hint.
 */
function formatDnssdBrowserErrorMessage(err: Error): string {
  const baseMessage = `Device discovery error: ${err.message || String(err)}`;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return `${baseMessage}. Current user is not root. Try running with sudo.`;
  }
  return baseMessage;
}
