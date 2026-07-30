import {describe, it} from 'node:test';

import {expect} from 'chai';

import {UdpMediaReceiver, isNextSequence, parseRtpPacket} from '../../../src/services/ios/display/rtp.js';

/** Options for {@link makeRtpPacket}. */
interface RtpFixtureOptions {
  payloadType?: number;
  marker?: boolean;
  sequence?: number;
  timestamp?: number;
  ssrc?: number;
  csrcCount?: number;
  /** Extension header length, in 32-bit words. Omit for no extension. */
  extensionWords?: number;
  payload?: Buffer;
}

function makeRtpPacket(options: RtpFixtureOptions = {}): Buffer {
  const {
    payloadType = 123,
    marker = false,
    sequence = 1,
    timestamp = 0,
    ssrc = 0xdeadbeef,
    csrcCount = 0,
    extensionWords,
    payload = Buffer.from('payload'),
  } = options;

  const header = Buffer.alloc(12);
  header[0] = 0x80 | (extensionWords === undefined ? 0 : 0x10) | csrcCount;
  header[1] = (marker ? 0x80 : 0) | payloadType;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);

  const csrc = Buffer.alloc(csrcCount * 4);
  const extension =
    extensionWords === undefined
      ? Buffer.alloc(0)
      : (() => {
          const ext = Buffer.alloc(4 + extensionWords * 4);
          ext.writeUInt16BE(0xbede, 0); // profile id
          ext.writeUInt16BE(extensionWords, 2);
          return ext;
        })();

  return Buffer.concat([header, csrc, extension, payload]);
}

describe('RTP', function () {
  describe('parseRtpPacket', function () {
    it('parses the fixed header fields', function () {
      const packet = parseRtpPacket(
        makeRtpPacket({payloadType: 123, marker: true, sequence: 4242, timestamp: 99, ssrc: 7}),
      );

      expect(packet).to.not.equal(undefined);
      expect(packet?.payloadType).to.equal(123);
      expect(packet?.marker).to.equal(true);
      expect(packet?.sequence).to.equal(4242);
      expect(packet?.timestamp).to.equal(99);
      expect(packet?.ssrc).to.equal(7);
      expect(packet?.payload).to.deep.equal(Buffer.from('payload'));
    });

    it('skips the CSRC list when locating the payload', function () {
      const packet = parseRtpPacket(makeRtpPacket({csrcCount: 3, payload: Buffer.from('body')}));

      expect(packet?.payload).to.deep.equal(Buffer.from('body'));
    });

    it('skips an extension header when locating the payload', function () {
      const packet = parseRtpPacket(makeRtpPacket({extensionWords: 2, payload: Buffer.from('body')}));

      expect(packet?.payload).to.deep.equal(Buffer.from('body'));
    });

    it('skips both a CSRC list and an extension header together', function () {
      const packet = parseRtpPacket(makeRtpPacket({csrcCount: 2, extensionWords: 1, payload: Buffer.from('body')}));

      expect(packet?.payload).to.deep.equal(Buffer.from('body'));
    });

    it('rejects RTCP packets, which share the port', function () {
      // RTCP types 200..207 appear as payload types 72..79 once the marker bit
      // is masked off; the whole 64..95 range is reserved for them.
      for (const payloadType of [64, 72, 78, 95]) {
        expect(parseRtpPacket(makeRtpPacket({payloadType}))).to.equal(undefined);
      }
    });

    it('accepts payload types just outside the RTCP range', function () {
      expect(parseRtpPacket(makeRtpPacket({payloadType: 63}))).to.not.equal(undefined);
      expect(parseRtpPacket(makeRtpPacket({payloadType: 96}))).to.not.equal(undefined);
      expect(parseRtpPacket(makeRtpPacket({payloadType: 101}))).to.not.equal(undefined); // audio
    });

    it('rejects datagrams shorter than the fixed header', function () {
      expect(parseRtpPacket(Buffer.alloc(11))).to.equal(undefined);
      expect(parseRtpPacket(Buffer.alloc(0))).to.equal(undefined);
    });

    it('rejects a packet whose declared extension runs past the end', function () {
      const truncated = makeRtpPacket({extensionWords: 4}).subarray(0, 14);

      expect(parseRtpPacket(truncated)).to.equal(undefined);
    });

    it('returns an empty payload for a header-only packet', function () {
      const packet = parseRtpPacket(makeRtpPacket({payload: Buffer.alloc(0)}));

      expect(packet?.payload).to.have.length(0);
    });
  });

  describe('isNextSequence', function () {
    it('accepts consecutive sequence numbers', function () {
      expect(isNextSequence(10, 11)).to.equal(true);
    });

    it('detects a gap', function () {
      expect(isNextSequence(10, 12)).to.equal(false);
      expect(isNextSequence(10, 10)).to.equal(false);
    });

    it('wraps at the 16-bit boundary', function () {
      expect(isNextSequence(0xffff, 0)).to.equal(true);
      expect(isNextSequence(0xffff, 1)).to.equal(false);
    });
  });

  describe('UdpMediaReceiver', function () {
    it('binds an ephemeral port and reports it', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        expect(receiver.port).to.be.greaterThan(0);
      } finally {
        receiver.close();
      }
    });

    it('buffers datagrams that arrive before the first read', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        const {createSocket} = await import('node:dgram');
        const sender = createSocket('udp6');
        await new Promise<void>((resolve, reject) => {
          sender.send(Buffer.from('first'), receiver.port, '::1', (error) => (error ? reject(error) : resolve()));
        });

        // Give the datagram time to land before anything starts consuming.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(receiver.pendingCount).to.equal(1);

        const iterator = receiver.packets();
        const {value} = await iterator.next();
        expect(value).to.deep.equal(Buffer.from('first'));

        sender.close();
        await iterator.return?.(undefined);
      } finally {
        receiver.close();
      }
    });

    it('ends the packet generator when closed', async function () {
      const receiver = await UdpMediaReceiver.bind();
      const iterator = receiver.packets();
      const pending = iterator.next();

      receiver.close();

      expect((await pending).done).to.equal(true);
    });

    it('ends the packet generator when the signal aborts', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        const controller = new AbortController();
        const iterator = receiver.packets(controller.signal);
        const pending = iterator.next();

        controller.abort();

        expect((await pending).done).to.equal(true);
      } finally {
        receiver.close();
      }
    });

    it('closes idempotently', async function () {
      const receiver = await UdpMediaReceiver.bind();

      receiver.close();
      receiver.close();
    });
  });
});
