import * as dnssd from 'dnssd';
import type { Service } from 'dnssd';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { getLogger } from '../logger.js';
import {
  DISCOVERY_DEFAULT_DOMAIN,
  DISCOVERY_DEFAULT_SERVICE_TYPE,
  DISCOVERY_DEFAULT_TIMEOUT_MS,
} from './constants.js';
import type {
  DiscoveredDevice,
  DiscoveredDeviceMetadata,
  DiscoveryOptions,
  IDeviceDiscoveryBackend,
} from './types.js';

const log = getLogger('DnssdDiscoveryBackend');

export class DnssdDiscoveryBackend implements IDeviceDiscoveryBackend {
  private inFlightDiscovery?: Promise<DiscoveredDevice[]>;

  constructor(
    private readonly options: DiscoveryOptions = {
      serviceType: DISCOVERY_DEFAULT_SERVICE_TYPE,
      domain: DISCOVERY_DEFAULT_DOMAIN,
    },
  ) {}

  async discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]> {
    if (this.inFlightDiscovery) {
      return await this.inFlightDiscovery;
    }
    this.inFlightDiscovery = this.runDiscovery(timeoutMs);
    try {
      return await this.inFlightDiscovery;
    } finally {
      this.inFlightDiscovery = undefined;
    }
  }

  private async runDiscovery(timeoutMs: number): Promise<DiscoveredDevice[]> {
    const serviceType =
      this.options.serviceType || DISCOVERY_DEFAULT_SERVICE_TYPE;
    const domain = this.options.domain || DISCOVERY_DEFAULT_DOMAIN;
    const browser = new dnssd.Browser(serviceType, {
      domain,
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

function normalizeHostname(host?: string): string | undefined {
  if (!host) {
    return undefined;
  }
  return host.endsWith('.') ? host : `${host}.`;
}

async function resolveIpAddress(
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

function formatDnssdBrowserErrorMessage(err: Error): string {
  const baseMessage = `Device discovery error: ${err.message || String(err)}`;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return `${baseMessage}. Current user is not root. Try running with sudo.`;
  }
  return baseMessage;
}
