import { type Socket, createSocket } from 'node:dgram';

import {
  MDNS_MCAST_V4,
  MDNS_PORT,
  QTYPE_A,
  QTYPE_PTR,
  QTYPE_SRV,
  QTYPE_TXT,
  buildServiceTypeFqdn,
  decodeName,
  encodeName,
} from '../../src/lib/discovery/mdns-protocol.js';

const CLASS_IN = 1;
const DNS_RESPONSE_FLAGS = 0x8400;
const DEFAULT_TTL = 120;

export interface MdnsAdvertisement {
  instanceName: string;
  serviceType: string;
  domain?: string;
  host?: string;
  port: number;
  ipv4: string;
  txt?: Record<string, string>;
}

export class MdnsTestResponder {
  private constructor(
    private readonly socketHandle: Socket,
    private readonly advertisements: MdnsAdvertisement[],
  ) {
    socketHandle.on('message', (message, rinfo) => {
      this.handleQuery(message, rinfo.address, rinfo.port);
    });
  }

  static async start(
    advertisements: MdnsAdvertisement[],
  ): Promise<MdnsTestResponder> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(MDNS_PORT, '0.0.0.0', () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    try {
      socket.addMembership(MDNS_MCAST_V4, '0.0.0.0');
    } catch {
      // membership may fail in some sandboxes; unicast replies can still work
    }
    return new MdnsTestResponder(socket, advertisements);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socketHandle.close(() => resolve());
    });
  }

  private handleQuery(
    message: Buffer,
    senderAddress: string,
    senderPort: number,
  ): void {
    const queryName = parseQueryName(message);
    if (!queryName) {
      return;
    }
    const advertisement = this.advertisements.find((entry) => {
      const domain = entry.domain ?? 'local';
      return buildServiceTypeFqdn(entry.serviceType, domain) === queryName;
    });
    if (!advertisement) {
      return;
    }
    const response = buildDiscoveryResponse(message, advertisement);
    this.socketHandle.send(response, senderPort, senderAddress);
    try {
      this.socketHandle.send(response, MDNS_PORT, MDNS_MCAST_V4);
    } catch {
      // optional multicast echo
    }
  }
}

function parseQueryName(message: Buffer): string | null {
  if (message.length < 12) {
    return null;
  }
  const flags = message.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) {
    return null;
  }
  const questionCount = message.readUInt16BE(4);
  if (questionCount < 1) {
    return null;
  }
  return decodeName(message, 12).name;
}

function buildDiscoveryResponse(
  query: Buffer,
  advertisement: MdnsAdvertisement,
): Buffer {
  const domain = advertisement.domain ?? 'local';
  const serviceTypeFqdn = buildServiceTypeFqdn(
    advertisement.serviceType,
    domain,
  );
  const instanceFqdn = `${advertisement.instanceName}.${serviceTypeFqdn}`;
  const host = advertisement.host ?? 'apptest-host.local.';
  const target = host.endsWith('.') ? host : `${host}.`;

  const ptrRdata = encodeName(instanceFqdn);
  const ptrRR = encodeResourceRecord(serviceTypeFqdn, QTYPE_PTR, ptrRdata);

  const srvBody = Buffer.alloc(6);
  srvBody.writeUInt16BE(0, 0);
  srvBody.writeUInt16BE(0, 2);
  srvBody.writeUInt16BE(advertisement.port, 4);
  const srvRdata = Buffer.concat([srvBody, encodeName(target)]);
  const srvRR = encodeResourceRecord(instanceFqdn, QTYPE_SRV, srvRdata);

  const txtRR = encodeResourceRecord(
    instanceFqdn,
    QTYPE_TXT,
    encodeTxtRecord(advertisement.txt ?? {}),
  );

  const ipv4Parts = advertisement.ipv4.split('.').map((octet) => Number(octet));
  const aRdata = Buffer.from(ipv4Parts);
  const aRR = encodeResourceRecord(target, QTYPE_A, aRdata);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(DNS_RESPONSE_FLAGS, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(3, 10);

  return Buffer.concat([header, ptrRR, srvRR, txtRR, aRR]);
}

function encodeTxtRecord(txt: Record<string, string>): Buffer {
  const segments = Object.entries(txt).map(([key, value]) =>
    Buffer.from(`${key}=${value}`),
  );
  return Buffer.concat(
    segments.map((segment) =>
      Buffer.concat([Buffer.from([segment.length]), segment]),
    ),
  );
}

function encodeResourceRecord(
  name: string,
  type: number,
  rdata: Buffer,
): Buffer {
  return Buffer.concat([
    encodeName(name),
    writeUint16(type),
    writeUint16(CLASS_IN),
    writeUint32(DEFAULT_TTL),
    writeUint16(rdata.length),
    rdata,
  ]);
}

function writeUint16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function writeUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUint32BE(value, 0);
  return buf;
}
