import {
  QTYPE_PTR,
  QTYPE_SRV,
  QTYPE_TXT,
  buildQuery,
  buildServiceTypeFqdn,
  decodeDnsSdInstanceName,
  decodeName,
  encodeName,
  parseMdnsMessage,
} from '../../../src/lib/discovery/mdns-protocol.js';

describe('mdns-protocol', function () {
  describe('encodeName / decodeName', function () {
    it('round-trips a multi-label DNS name', function () {
      const fqdn = '_remotepairing._tcp.local.';
      const encoded = encodeName(fqdn);
      const { name } = decodeName(encoded, 0);
      expect(name).to.equal(fqdn);
    });

    it('round-trips Apple long service type names', function () {
      const fqdn = '_remotepairing-manual-pairing._tcp.local.';
      const encoded = encodeName(fqdn);
      const { name } = decodeName(encoded, 0);
      expect(name).to.equal(fqdn);
    });

    it('reports which label exceeds the 63-octet limit', function () {
      const longLabel = 'a'.repeat(65);
      let message = '';
      try {
        encodeName(`${longLabel}.local.`);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).to.match(/^DNS label "/);
      expect(message).to.include('…');
      expect(message).to.include('65 octets in UTF-8');
      expect(message).to.include('at most 63 octets');
    });
  });

  describe('buildServiceTypeFqdn', function () {
    it('builds a trailing-dot FQDN from type and domain', function () {
      expect(buildServiceTypeFqdn('_remotepairing._tcp', 'local')).to.equal(
        '_remotepairing._tcp.local.',
      );
      expect(
        buildServiceTypeFqdn('_remotepairing-manual-pairing._tcp', 'local'),
      ).to.equal('_remotepairing-manual-pairing._tcp.local.');
    });
  });

  describe('decodeDnsSdInstanceName', function () {
    it('decodes decimal-escaped spaces', function () {
      const wireName = `Living${String.fromCharCode(92)}032Room`;
      expect(decodeDnsSdInstanceName(wireName)).to.equal('Living Room');
    });
  });

  describe('buildQuery', function () {
    it('encodes a PTR question for the service type', function () {
      const query = buildQuery('_remotepairing._tcp.local.', QTYPE_PTR);
      expect(query.readUInt16BE(4)).to.equal(1);
      const { name, offset } = decodeName(query, 12);
      expect(name).to.equal('_remotepairing._tcp.local.');
      expect(query.readUInt16BE(offset)).to.equal(QTYPE_PTR);
    });
  });

  describe('parseMdnsMessage', function () {
    it('parses PTR, SRV, and TXT records from a synthetic response', function () {
      const instance = 'Bedroom._remotepairing._tcp.local.';
      const serviceType = '_remotepairing._tcp.local.';
      const target = 'appletv.local.';
      const header = Buffer.alloc(12);
      header.writeUInt16BE(0, 4);
      header.writeUInt16BE(3, 6);
      header.writeUInt16BE(0, 8);
      header.writeUInt16BE(0, 10);

      const ptrRdata = encodeName(instance);
      const ptrRR = Buffer.concat([
        encodeName(serviceType),
        uint16(QTYPE_PTR),
        uint16(1),
        uint32(120),
        uint16(ptrRdata.length),
        ptrRdata,
      ]);

      const srvRdataStart = Buffer.alloc(6);
      srvRdataStart.writeUInt16BE(0, 0);
      srvRdataStart.writeUInt16BE(0, 2);
      srvRdataStart.writeUInt16BE(49152, 4);
      const srvRdata = Buffer.concat([srvRdataStart, encodeName(target)]);
      const srvRR = Buffer.concat([
        encodeName(instance),
        uint16(QTYPE_SRV),
        uint16(1),
        uint32(120),
        uint16(srvRdata.length),
        srvRdata,
      ]);

      const txtSegment = Buffer.from('identifier=tv1');
      const txtPayload = Buffer.concat([
        Buffer.from([txtSegment.length]),
        txtSegment,
      ]);
      const txtRR = Buffer.concat([
        encodeName(instance),
        uint16(QTYPE_TXT),
        uint16(1),
        uint32(120),
        uint16(txtPayload.length),
        txtPayload,
      ]);

      const packet = Buffer.concat([header, ptrRR, srvRR, txtRR]);
      const records = parseMdnsMessage(packet);

      expect(records).to.have.length(3);
      expect(records[0]?.ptrdname).to.equal(instance);
      expect(records[1]?.port).to.equal(49152);
      expect(records[1]?.target).to.equal(target);
      expect(records[2]?.txt).to.deep.equal({ identifier: 'tv1' });
    });
  });
});

function uint16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}
