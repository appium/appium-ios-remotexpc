import { getLogger } from '../logger.js';
import { BaseDiscoveryBackend } from './base-discovery-backend.js';
import { DISCOVERY_DEFAULT_TIMEOUT_MS } from './constants.js';
import { normalizeHostname, resolveIpAddress } from './discovery-utils.js';
import { browseMdnsService } from './mdns-browser.js';
import {
  buildServiceTypeFqdn,
  decodeDnsSdInstanceName,
} from './mdns-protocol.js';
import type {
  DiscoveredDevice,
  DiscoveredDeviceMetadata,
  DiscoveryOptions,
} from './types.js';

const log = getLogger('MdnsDiscoveryBackend');

/**
 * Cross-platform discovery via a raw mDNS browser (UDP port 5353).
 *
 * Unlike the `dnssd` npm package or strict pure-JS mDNS clients, this path
 * does not enforce RFC 6335 service-name length limits, so Apple's long
 * DNS-SD types (e.g. `_remotepairing-manual-pairing._tcp`) work on all
 * platforms.
 */
export class MdnsDiscoveryBackend extends BaseDiscoveryBackend {
  constructor(options?: DiscoveryOptions) {
    super(options);
  }

  protected override async runDiscovery(
    timeoutMs: number,
  ): Promise<DiscoveredDevice[]> {
    const browseTimeout = Math.max(timeoutMs, DISCOVERY_DEFAULT_TIMEOUT_MS);
    let instances;
    try {
      instances = await browseMdnsService(
        this.serviceType,
        this.domain,
        browseTimeout,
      );
    } catch (err) {
      const message = formatMdnsBrowseError(err);
      log.warn(message);
      throw new Error(message, { cause: err });
    }

    if (instances.length === 0) {
      return [];
    }

    const settled = await Promise.allSettled(
      instances.map((instance) =>
        instanceToDevice(instance, this.serviceType, this.domain),
      ),
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

async function instanceToDevice(
  instance: Awaited<ReturnType<typeof browseMdnsService>>[number],
  serviceType: string,
  domain: string,
): Promise<DiscoveredDevice | null> {
  try {
    const name = extractInstanceName(instance.instance, serviceType, domain);
    const hostname = normalizeHostname(instance.host);
    if (!hostname || !instance.port) {
      return null;
    }
    const ipv4 = instance.addresses.find((addr) => !addr.includes(':'));
    const ip = await resolveIpAddress(
      hostname,
      ipv4 ? [ipv4] : instance.addresses,
    );
    const txt = instance.properties;
    const identifier = txt.identifier ?? name;
    const metadata: DiscoveredDeviceMetadata = {
      identifier,
      model: txt.model ?? '',
      version: txt.ver ?? '',
    };
    return {
      id: identifier,
      name,
      hostname,
      ip,
      port: instance.port,
      metadata,
    };
  } catch (err) {
    log.warn(`Failed to process mDNS service ${instance.instance}: ${err}`);
    return null;
  }
}

function extractInstanceName(
  instanceFqdn: string,
  serviceType: string,
  domain: string,
): string {
  const suffix = buildServiceTypeFqdn(serviceType, domain);
  const normalized = instanceFqdn.endsWith('.')
    ? instanceFqdn
    : `${instanceFqdn}.`;
  if (normalized.endsWith(suffix)) {
    const raw = normalized.slice(0, -suffix.length).replace(/\.$/, '');
    return decodeDnsSdInstanceName(raw);
  }
  const firstLabel = normalized.slice(0, -1).split('.')[0] ?? normalized;
  return decodeDnsSdInstanceName(firstLabel);
}

function formatMdnsBrowseError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const base = `mDNS browse failed: ${detail}`;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return `${base}. Binding to UDP port 5353 may require elevated privileges; try running with sudo.`;
  }
  return base;
}
