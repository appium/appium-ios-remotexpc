import * as dnssd from 'dnssd';
import type { Service } from 'dnssd';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { getLogger } from '../logger.js';
import {
  DISCOVERY_DEFAULT_DOMAIN,
  DISCOVERY_DEFAULT_SERVICE_TYPE,
  DISCOVERY_TIMEOUTS,
} from './constants.js';
import type {
  DiscoveredDevice,
  DiscoveredDeviceMetadata,
  DiscoveryOptions,
  IDeviceDiscoveryBackend,
} from './types.js';

const log = getLogger('DnssdDiscoveryBackend');

export class DnssdDiscoveryBackend implements IDeviceDiscoveryBackend {
  constructor(
    private readonly options: DiscoveryOptions = {
      serviceType: DISCOVERY_DEFAULT_SERVICE_TYPE,
      domain: DISCOVERY_DEFAULT_DOMAIN,
    },
  ) {}

  async discoverDevices(timeoutMs: number): Promise<DiscoveredDevice[]> {
    const serviceType =
      this.options.serviceType || DISCOVERY_DEFAULT_SERVICE_TYPE;
    const domain = this.options.domain || DISCOVERY_DEFAULT_DOMAIN;
    const browser = new dnssd.Browser(serviceType, {
      domain,
    });
    const devices = new Map<string, DiscoveredDevice>();
    let browserError: Error | null = null;

    browser.on('serviceUp', async (service: Service) => {
      try {
        const hostname = normalizeHostname(service.host);
        if (!hostname || !service.port) {
          return;
        }
        const txt = service.txt ?? {};
        const ip = await resolveIpAddress(hostname, service.addresses);
        const identifier = txt.identifier ?? service.name ?? hostname;
        const metadata: DiscoveredDeviceMetadata = {
          identifier,
          model: txt.model ?? '',
          version: txt.ver ?? '',
          minVersion: txt.minVer ?? '17',
          authTag: txt.authTag,
          serviceType,
        };
        devices.set(identifier, {
          id: identifier,
          name: service.name ?? identifier,
          hostname,
          ip,
          port: service.port,
          metadata,
        });
      } catch (err) {
        log.warn(`Failed to process dnssd service: ${err}`);
      }
    });

    browser.on('error', (err: Error) => {
      const message = formatDnssdBrowserErrorMessage(err);
      browserError = new Error(message, { cause: err });
      log.warn(`dnssd browser error: ${message}`);
    });

    browser.start();
    try {
      await delay(Math.max(timeoutMs, DISCOVERY_TIMEOUTS.DEFAULT_DISCOVERY));
      if (browserError) {
        throw browserError;
      }
      return Array.from(devices.values());
    } finally {
      browser.stop();
    }
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
  const baseMessage = err.message || String(err);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return `${baseMessage}. Current user is not root. Try running with sudo.`;
  }
  return baseMessage;
}
