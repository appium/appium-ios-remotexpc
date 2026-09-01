import type {XPCDictionary} from '../types.js';
import {decodeMessage, probeXpcFraming} from './xpc-protocol.js';

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
  private desynced = false;

  /**
   * Feed one DATA frame payload. Returns the catalog once a complete XPC message
   * carrying `Services` decodes. Framed-but-undecodable messages are skipped.
   * @throws once the stream desyncs, and on every later call — no payload can resynchronise it
   */
  ingestDataPayload(chunk: Buffer): ServicesResponse | null {
    if (this.desynced) {
      throw new Error('XPC stream is desynced');
    }

    let pending = Buffer.concat([this.previousFrameData, chunk]);
    this.previousFrameData = Buffer.alloc(0);

    while (pending.length > 0) {
      const framing = probeXpcFraming(pending);
      if (framing.status === 'incomplete') {
        this.previousFrameData = pending;
        return null;
      }
      if (framing.status === 'desynced') {
        this.desynced = true;
        throw new Error(framing.reason);
      }

      const message = pending.subarray(0, framing.byteLength);
      pending = pending.subarray(framing.byteLength);

      const catalog = extractCatalog(message);
      if (catalog) {
        this.previousFrameData = pending;
        return catalog;
      }
    }

    return null;
  }
}

/** Catalog carried by one complete XPC message; null if it carries none or will not decode. */
function extractCatalog(message: Buffer): ServicesResponse | null {
  try {
    return servicesFromXpcBody(decodeMessage(message).message.body);
  } catch {
    return null;
  }
}

/**
 * Build the service list from a decoded RSD handshake body (`peer_info`).
 */
export function servicesFromXpcBody(body: XPCDictionary | null | undefined): ServicesResponse | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const servicesDict = body.Services;
  if (!servicesDict || typeof servicesDict !== 'object' || Array.isArray(servicesDict)) {
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
      port: portValue !== undefined && portValue !== null ? String(portValue) : '',
    });
  }

  return services.length > 0 ? {services} : null;
}
