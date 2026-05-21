import type { XPCDictionary } from '../types.js';
import { decodeMessage } from './xpc-protocol.js';

export interface Service {
  serviceName: string;
  port: string;
}

export interface ServicesResponse {
  services: Service[];
}

/**
 * Reassemble length-prefixed XPC payloads from HTTP/2 DATA frames and extract
 * the service catalog once the full handshake message is available.
 */
export class ServiceCatalogCollector {
  private previousFrameData: Buffer = Buffer.alloc(0);

  /**
   * Feed one DATA frame payload. Returns the catalog when a complete XPC
   * message containing `Services` has been decoded.
   */
  ingestDataPayload(chunk: Buffer): ServicesResponse | null {
    const combined = Buffer.concat([this.previousFrameData, chunk]);

    try {
      const message = decodeMessage(combined);
      this.previousFrameData = Buffer.alloc(0);

      if (message.body === null || message.body === undefined) {
        return null;
      }

      return servicesFromXpcBody(message.body);
    } catch {
      this.previousFrameData = combined;
      return null;
    }
  }
}

/**
 * Build the service list from a decoded RSD handshake body (`peer_info`).
 */
export function servicesFromXpcBody(
  body: XPCDictionary | null | undefined,
): ServicesResponse | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const servicesDict = body.Services;
  if (
    !servicesDict ||
    typeof servicesDict !== 'object' ||
    Array.isArray(servicesDict)
  ) {
    return null;
  }

  const services: Service[] = [];
  for (const [serviceName, info] of Object.entries(servicesDict)) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      continue;
    }
    const portValue = (info as XPCDictionary).Port;
    services.push({
      serviceName,
      port:
        portValue !== undefined && portValue !== null ? String(portValue) : '',
    });
  }

  return services.length > 0 ? { services } : null;
}
