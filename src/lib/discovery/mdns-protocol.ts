/**
 * Minimal DNS/mDNS packet helpers for raw service browsing.
 *
 * No third-party mDNS library and no RFC 6335 service-name length checks, so
 * Apple's long DNS-SD types work.
 */

export const MDNS_PORT = 5353;
export const MDNS_MCAST_V4 = '224.0.0.251';
export const MDNS_MCAST_V6 = 'ff02::fb';

export const QTYPE_A = 1;
export const QTYPE_PTR = 12;
export const QTYPE_TXT = 16;
export const QTYPE_AAAA = 28;
export const QTYPE_SRV = 33;

const CLASS_IN = 0x0001;
const CLASS_QU = 0x8000;

/** Maximum octets per DNS label (RFC 1035). */
const DNS_MAX_LABEL_OCTETS = 63;

const DNS_HEADER_OCTETS = 12;
const DNS_QUESTION_TAIL_OCTETS = 4;
const DNS_RR_HEADER_OCTETS = 10;
const DNS_RR_CLASS_OFFSET = 2;
const DNS_RR_TTL_OFFSET = 4;
const DNS_RR_RDLEN_OFFSET = 8;

const DNS_SRV_HEADER_OCTETS = 6;
const DNS_SRV_PORT_OFFSET = 4;

const DNS_A_RDATA_OCTETS = 4;
const DNS_AAAA_RDATA_OCTETS = 16;
const DNS_AAAA_GROUP_OCTETS = 2;

const DNS_NAME_POINTER_OCTETS = 2;
const DNS_NAME_COMPRESSION_PREFIX = 0xc0;
const DNS_NAME_POINTER_MASK = 0x3f;
const DNS_CLASS_FLUSH_MASK = 0x7fff;

const DNS_DECODE_LOOP_LIMIT = 128;
const DNS_LABEL_PREVIEW_MAX_CHARS = 64;
const DNS_LABEL_PREVIEW_PREFIX_CHARS = 61;

export interface ParsedResourceRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  ptrdname?: string;
  priority?: number;
  weight?: number;
  port?: number;
  target?: string;
  txt?: Record<string, string>;
  address?: string;
  raw?: Buffer;
}

/** Encode a dotted DNS name as a length-prefixed wire-format name. */
export function encodeName(name: string): Buffer {
  const trimmed = name.replace(/\.$/, '');
  const parts: Buffer[] = [];
  for (const label of trimmed ? trimmed.split('.') : []) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > DNS_MAX_LABEL_OCTETS) {
      const preview =
        label.length > DNS_LABEL_PREVIEW_MAX_CHARS ? `${label.slice(0, DNS_LABEL_PREVIEW_PREFIX_CHARS)}…` : label;
      throw new Error(
        `DNS label "${preview}" is ${bytes.length} octets in UTF-8; ` +
          `each label in "${trimmed}" must be at most ${DNS_MAX_LABEL_OCTETS} octets`,
      );
    }
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Decode a wire-format DNS name starting at `offset`. */
export function decodeName(data: Buffer, offset: number): {name: string; offset: number} {
  const labels: string[] = [];
  let jumped = false;
  let end = offset;

  for (let guard = 0; guard < DNS_DECODE_LOOP_LIMIT; guard += 1) {
    if (offset >= data.length) {
      break;
    }
    const length = data[offset];
    if (length === undefined) {
      break;
    }
    if (length === 0) {
      offset += 1;
      break;
    }
    if ((length & DNS_NAME_COMPRESSION_PREFIX) === DNS_NAME_COMPRESSION_PREFIX) {
      if (offset + 1 >= data.length) {
        throw makeDnsDecodeError(`compression pointer at offset ${offset} is missing its second octet`, data, offset);
      }
      const pointerByte = data[offset + 1];
      if (pointerByte === undefined) {
        throw makeDnsDecodeError(`compression pointer at offset ${offset} is missing its second octet`, data, offset);
      }
      const pointer = ((length & DNS_NAME_POINTER_MASK) << 8) | pointerByte;
      if (pointer >= data.length) {
        throw makeDnsDecodeError(
          `compression pointer 0x${pointer.toString(16)} points past end of packet (length ${data.length})`,
          data,
          offset,
        );
      }
      if (!jumped) {
        end = offset + DNS_NAME_POINTER_OCTETS;
      }
      offset = pointer;
      jumped = true;
      continue;
    }
    if (length > DNS_MAX_LABEL_OCTETS) {
      throw makeDnsDecodeError(
        `label length ${length} at offset ${offset} exceeds maximum ${DNS_MAX_LABEL_OCTETS} octets`,
        data,
        offset,
      );
    }
    offset += 1;
    const labelEnd = offset + length;
    if (labelEnd > data.length) {
      throw makeDnsDecodeError(
        `label length ${length} at offset ${offset - 1} needs ${labelEnd} octets but packet has ${data.length}`,
        data,
        offset - 1,
      );
    }
    labels.push(data.subarray(offset, labelEnd).toString('utf8'));
    offset = labelEnd;
  }

  return {name: `${labels.join('.')}.`, offset: jumped ? end : offset};
}

/** Build a DNS query packet with a single question. */
export function buildQuery(name: string, qtype: number, unicast = false): Buffer {
  const header = Buffer.alloc(DNS_HEADER_OCTETS);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qclass = CLASS_IN | (unicast ? CLASS_QU : 0);
  const questionTail = Buffer.alloc(DNS_QUESTION_TAIL_OCTETS);
  questionTail.writeUInt16BE(qtype, 0);
  questionTail.writeUInt16BE(qclass, 2);
  return Buffer.concat([header, encodeName(name), questionTail]);
}

/** Parse answer/authority/additional records from an mDNS response packet. */
export function parseMdnsMessage(data: Buffer): ParsedResourceRecord[] {
  if (data.length < DNS_HEADER_OCTETS) {
    return [];
  }
  const qdcount = data.readUInt16BE(4);
  const ancount = data.readUInt16BE(6);
  const nscount = data.readUInt16BE(8);
  const arcount = data.readUInt16BE(10);
  let offset = DNS_HEADER_OCTETS;

  for (let i = 0; i < qdcount; i += 1) {
    const {offset: nameEnd} = decodeName(data, offset);
    offset = nameEnd + DNS_QUESTION_TAIL_OCTETS;
  }

  const records: ParsedResourceRecord[] = [];
  const total = ancount + nscount + arcount;
  for (let i = 0; i < total; i += 1) {
    const {rr, offset: next} = parseResourceRecord(data, offset);
    records.push(rr);
    offset = next;
  }
  return records;
}

/**
 * Decode DNS-SD decimal escape sequences in instance names (e.g. `\032` → space).
 *
 * Per RFC 6763, `\DDD` uses three decimal digits for the byte value, not octal.
 */
export function decodeDnsSdInstanceName(name: string): string {
  return name.replace(/\\(\d{3})/g, (_match, digits: string) => String.fromCharCode(parseInt(digits, 10)));
}

/** Build a trailing-dot FQDN from a DNS-SD type and domain (e.g. `local`). */
export function buildServiceTypeFqdn(serviceType: string, domain: string): string {
  const type = serviceType.endsWith('.') ? serviceType.slice(0, -1) : serviceType;
  const zone = domain.endsWith('.') ? domain.slice(0, -1) : domain;
  return `${type}.${zone}.`;
}

function makeDnsDecodeError(detail: string, data: Buffer, offset: number): Error {
  return new Error(`Failed to decode DNS name at offset ${offset} in ${data.length}-octet packet: ${detail}`);
}

function parseResourceRecord(data: Buffer, offset: number): {rr: ParsedResourceRecord; offset: number} {
  const {name, offset: nameEnd} = decodeName(data, offset);
  if (nameEnd + DNS_RR_HEADER_OCTETS > data.length) {
    throw new Error('truncated resource record header');
  }
  const rtype = data.readUInt16BE(nameEnd);
  const rclass = data.readUInt16BE(nameEnd + DNS_RR_CLASS_OFFSET);
  const ttl = data.readUInt32BE(nameEnd + DNS_RR_TTL_OFFSET);
  const rdlen = data.readUInt16BE(nameEnd + DNS_RR_RDLEN_OFFSET);
  const rdataStart = nameEnd + DNS_RR_HEADER_OCTETS;
  const rdataEnd = rdataStart + rdlen;
  if (rdataEnd > data.length) {
    throw new Error('truncated resource record data');
  }
  const rdata = data.subarray(rdataStart, rdataEnd);
  const next = rdataEnd;

  const rr: ParsedResourceRecord = {
    name,
    type: rtype,
    class: rclass & DNS_CLASS_FLUSH_MASK,
    ttl,
  };

  if (rtype === QTYPE_PTR) {
    const {name: ptrdname} = decodeName(data, rdataStart);
    rr.ptrdname = ptrdname;
  } else if (rtype === QTYPE_SRV && rdlen >= DNS_SRV_HEADER_OCTETS) {
    rr.priority = rdata.readUInt16BE(0);
    rr.weight = rdata.readUInt16BE(2);
    rr.port = rdata.readUInt16BE(DNS_SRV_PORT_OFFSET);
    const {name: target} = decodeName(data, rdataStart + DNS_SRV_HEADER_OCTETS);
    rr.target = target;
  } else if (rtype === QTYPE_TXT) {
    const kv: Record<string, string> = {};
    let index = 0;
    while (index < rdlen) {
      const segmentLen = rdata[index];
      if (segmentLen === undefined) {
        break;
      }
      index += 1;
      const segment = rdata.subarray(index, index + segmentLen);
      index += segmentLen;
      if (segment.length === 0) {
        continue;
      }
      const eq = segment.indexOf('='.charCodeAt(0));
      if (eq >= 0) {
        kv[segment.subarray(0, eq).toString()] = segment.subarray(eq + 1).toString();
      } else {
        kv[segment.toString()] = '';
      }
    }
    rr.txt = kv;
  } else if (rtype === QTYPE_A && rdlen === DNS_A_RDATA_OCTETS) {
    rr.address = Array.from(rdata)
      .map((octet) => octet.toString())
      .join('.');
  } else if (rtype === QTYPE_AAAA && rdlen === DNS_AAAA_RDATA_OCTETS) {
    const segments: string[] = [];
    for (let i = 0; i < DNS_AAAA_RDATA_OCTETS; i += DNS_AAAA_GROUP_OCTETS) {
      segments.push(rdata.readUInt16BE(i).toString(16));
    }
    rr.address = segments.join(':');
  } else {
    rr.raw = Buffer.from(rdata);
  }

  return {rr, offset: next};
}
