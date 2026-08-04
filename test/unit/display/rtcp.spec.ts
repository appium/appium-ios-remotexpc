import {describe, it} from 'node:test';

import {expect} from 'chai';

import type {XPCDictionary} from '../../../src/lib/types.js';
import {
  RtcpKeepalive,
  type RtcpStreamIdentity,
  buildReceiverReport,
  rtcpIdentityFromStreamConfig,
} from '../../../src/services/ios/display/rtcp.js';
import type {UdpMediaReceiver} from '../../../src/services/ios/display/rtp.js';

const IDENTITY: RtcpStreamIdentity = {
  localSsrc: 0x11223344,
  remoteSsrc: 0xaabbccdd,
  host: 'fdaf:3d19:679::1',
  port: 50436,
};

/** Captures what a keepalive sends, standing in for a bound socket. */
function fakeReceiver(): {receiver: UdpMediaReceiver; sent: Array<{data: Buffer; host: string; port: number}>} {
  const sent: Array<{data: Buffer; host: string; port: number}> = [];
  const receiver = {
    async send(data: Buffer, host: string, port: number): Promise<void> {
      sent.push({data, host, port});
    },
  } as unknown as UdpMediaReceiver;
  return {receiver, sent};
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('RTCP', function () {
  describe('buildReceiverReport', function () {
    it('emits a 44-byte RR + SDES compound', function () {
      const packet = buildReceiverReport(IDENTITY);

      expect(packet).to.have.length(44); // 32-byte RR + 12-byte SDES
    });

    it('builds the Receiver Report header per RFC 3550 §6.4.2', function () {
      const packet = buildReceiverReport(IDENTITY);

      expect(packet.readUInt8(0)).to.equal(0x81); // version 2, one report block
      expect(packet.readUInt8(1)).to.equal(0xc9); // PT 201 = RR
      expect(packet.readUInt16BE(2)).to.equal(7); // (7 + 1) * 4 = 32 bytes
    });

    it('reports our SSRC as sender and the device SSRC as the reported source', function () {
      const packet = buildReceiverReport(IDENTITY);

      // Getting these backwards makes the device ignore the report, so the
      // session still dies at 20s — worth pinning down explicitly.
      expect(packet.readUInt32BE(4)).to.equal(IDENTITY.localSsrc);
      expect(packet.readUInt32BE(8)).to.equal(IDENTITY.remoteSsrc);
    });

    it('reports no packet loss so the device does not throttle its encoder', function () {
      const packet = buildReceiverReport(IDENTITY, 1234);

      expect(packet.readUInt32BE(12)).to.equal(0); // fraction lost + cumulative lost
    });

    it('carries the extended highest sequence number', function () {
      expect(buildReceiverReport(IDENTITY, 0x0001abcd).readUInt32BE(16)).to.equal(0x0001abcd);
      expect(buildReceiverReport(IDENTITY).readUInt32BE(16)).to.equal(0);
    });

    it('appends the SDES chunk Xcode sends', function () {
      const sdes = buildReceiverReport(IDENTITY).subarray(32);

      expect(sdes.readUInt8(0)).to.equal(0x81);
      expect(sdes.readUInt8(1)).to.equal(0xca); // PT 202 = SDES
      expect(sdes.readUInt16BE(2)).to.equal(2); // (2 + 1) * 4 = 12 bytes
      expect(sdes.readUInt32BE(4)).to.equal(IDENTITY.localSsrc);
      expect(sdes.readUInt8(8)).to.equal(0x01); // CNAME item, zero length
      expect(sdes.subarray(9)).to.deep.equal(Buffer.alloc(3)); // terminator + padding
    });

    it('handles SSRCs with the high bit set', function () {
      const packet = buildReceiverReport({...IDENTITY, localSsrc: 0xffffffff, remoteSsrc: 0x80000000});

      expect(packet.readUInt32BE(4)).to.equal(0xffffffff);
      expect(packet.readUInt32BE(8)).to.equal(0x80000000);
    });
  });

  describe('rtcpIdentityFromStreamConfig', function () {
    it('maps the device-perspective SSRC names onto ours', function () {
      // streamConfig is written from the device's point of view: its "Remote"
      // is us, its "Local" is itself.
      const streamConfig: XPCDictionary = {RemoteSSRC: 111, LocalSSRC: 222, SourcePort: 50436};

      expect(rtcpIdentityFromStreamConfig(streamConfig, 'fd00::1')).to.deep.equal({
        localSsrc: 111,
        remoteSsrc: 222,
        host: 'fd00::1',
        port: 50436,
      });
    });

    it('returns undefined when the device omits the fields', function () {
      expect(rtcpIdentityFromStreamConfig({}, 'fd00::1')).to.equal(undefined);
      expect(rtcpIdentityFromStreamConfig({RemoteSSRC: 1, LocalSSRC: 2}, 'fd00::1')).to.equal(undefined);
      expect(rtcpIdentityFromStreamConfig({RemoteSSRC: 1, SourcePort: 5}, 'fd00::1')).to.equal(undefined);
    });

    it('rejects a zero source port, which is not a valid destination', function () {
      expect(rtcpIdentityFromStreamConfig({RemoteSSRC: 1, LocalSSRC: 2, SourcePort: 0}, 'fd00::1')).to.equal(undefined);
    });
  });

  describe('RtcpKeepalive', function () {
    it('sends the first report immediately, without waiting for media', async function () {
      // A static or silent screen produces no RTP for a while; gating the first
      // report on received packets would let the device reap the session first.
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 60_000});

      await flush();

      expect(sent).to.have.length(1);
      expect(sent[0].host).to.equal(IDENTITY.host);
      expect(sent[0].port).to.equal(IDENTITY.port);
      keepalive.stop();
    });

    it('keeps sending on the interval', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 10});

      await new Promise((resolve) => setTimeout(resolve, 55));
      keepalive.stop();

      expect(sent.length).to.be.greaterThan(2);
    });

    it('stops sending after stop()', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 10});
      await flush();

      keepalive.stop();
      const afterStop = sent.length;
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(sent.length).to.equal(afterStop);
    });

    it('is safe to stop twice', function () {
      const {receiver} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 10});

      keepalive.stop();
      keepalive.stop();
    });

    it('reports the highest observed sequence number', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 5});
      keepalive.observeSequence(10);
      keepalive.observeSequence(42);
      keepalive.observeSequence(30); // out of order, must not lower the value

      await new Promise((resolve) => setTimeout(resolve, 20));
      keepalive.stop();

      expect(sent[sent.length - 1].data.readUInt32BE(16)).to.equal(42);
    });

    it('counts a 16-bit wraparound as a new cycle', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 5});
      keepalive.observeSequence(0xfffe);
      keepalive.observeSequence(0xffff);
      keepalive.observeSequence(0x0000); // wrapped

      await new Promise((resolve) => setTimeout(resolve, 20));
      keepalive.stop();

      // One cycle elapsed, so the extended value is 65536, not 0.
      expect(sent[sent.length - 1].data.readUInt32BE(16)).to.equal(0x10000);
    });
  });
});
