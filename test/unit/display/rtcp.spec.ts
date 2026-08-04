import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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

      assert.strictEqual(packet.length, 44); // 32-byte RR + 12-byte SDES
    });

    it('builds the Receiver Report header per RFC 3550 §6.4.2', function () {
      const packet = buildReceiverReport(IDENTITY);

      assert.strictEqual(packet.readUInt8(0), 0x81); // version 2, one report block
      assert.strictEqual(packet.readUInt8(1), 0xc9); // PT 201 = RR
      assert.strictEqual(packet.readUInt16BE(2), 7); // (7 + 1) * 4 = 32 bytes
    });

    it('reports our SSRC as sender and the device SSRC as the reported source', function () {
      const packet = buildReceiverReport(IDENTITY);

      // Getting these backwards makes the device ignore the report, so the
      // session still dies at 20s — worth pinning down explicitly.
      assert.strictEqual(packet.readUInt32BE(4), IDENTITY.localSsrc);
      assert.strictEqual(packet.readUInt32BE(8), IDENTITY.remoteSsrc);
    });

    it('reports no packet loss so the device does not throttle its encoder', function () {
      const packet = buildReceiverReport(IDENTITY, 1234);

      assert.strictEqual(packet.readUInt32BE(12), 0); // fraction lost + cumulative lost
    });

    it('carries the extended highest sequence number', function () {
      assert.strictEqual(buildReceiverReport(IDENTITY, 0x0001abcd).readUInt32BE(16), 0x0001abcd);
      assert.strictEqual(buildReceiverReport(IDENTITY).readUInt32BE(16), 0);
    });

    it('appends the SDES chunk Xcode sends', function () {
      const sdes = buildReceiverReport(IDENTITY).subarray(32);

      assert.strictEqual(sdes.readUInt8(0), 0x81);
      assert.strictEqual(sdes.readUInt8(1), 0xca); // PT 202 = SDES
      assert.strictEqual(sdes.readUInt16BE(2), 2); // (2 + 1) * 4 = 12 bytes
      assert.strictEqual(sdes.readUInt32BE(4), IDENTITY.localSsrc);
      assert.strictEqual(sdes.readUInt8(8), 0x01); // CNAME item, zero length
      assert.deepStrictEqual(sdes.subarray(9), Buffer.alloc(3)); // terminator + padding
    });

    it('handles SSRCs with the high bit set', function () {
      const packet = buildReceiverReport({...IDENTITY, localSsrc: 0xffffffff, remoteSsrc: 0x80000000});

      assert.strictEqual(packet.readUInt32BE(4), 0xffffffff);
      assert.strictEqual(packet.readUInt32BE(8), 0x80000000);
    });
  });

  describe('rtcpIdentityFromStreamConfig', function () {
    it('maps the device-perspective SSRC names onto ours', function () {
      // streamConfig is written from the device's point of view: its "Remote"
      // is us, its "Local" is itself.
      const streamConfig: XPCDictionary = {RemoteSSRC: 111, LocalSSRC: 222, SourcePort: 50436};

      assert.deepStrictEqual(rtcpIdentityFromStreamConfig(streamConfig, 'fd00::1'), {
        localSsrc: 111,
        remoteSsrc: 222,
        host: 'fd00::1',
        port: 50436,
      });
    });

    it('returns undefined when the device omits the fields', function () {
      assert.strictEqual(rtcpIdentityFromStreamConfig({}, 'fd00::1'), undefined);
      assert.strictEqual(rtcpIdentityFromStreamConfig({RemoteSSRC: 1, LocalSSRC: 2}, 'fd00::1'), undefined);
      assert.strictEqual(rtcpIdentityFromStreamConfig({RemoteSSRC: 1, SourcePort: 5}, 'fd00::1'), undefined);
    });

    it('rejects a zero source port, which is not a valid destination', function () {
      assert.strictEqual(
        rtcpIdentityFromStreamConfig({RemoteSSRC: 1, LocalSSRC: 2, SourcePort: 0}, 'fd00::1'),
        undefined,
      );
    });
  });

  describe('RtcpKeepalive', function () {
    it('sends the first report immediately, without waiting for media', async function () {
      // A static or silent screen produces no RTP for a while; gating the first
      // report on received packets would let the device reap the session first.
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 60_000});

      await flush();

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].host, IDENTITY.host);
      assert.strictEqual(sent[0].port, IDENTITY.port);
      keepalive.stop();
    });

    it('keeps sending on the interval', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 10});

      await new Promise((resolve) => setTimeout(resolve, 55));
      keepalive.stop();

      assert.ok(sent.length > 2);
    });

    it('stops sending after stop()', async function () {
      const {receiver, sent} = fakeReceiver();
      const keepalive = RtcpKeepalive.start(receiver, IDENTITY, {intervalMs: 10});
      await flush();

      keepalive.stop();
      const afterStop = sent.length;
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.strictEqual(sent.length, afterStop);
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

      assert.strictEqual(sent[sent.length - 1].data.readUInt32BE(16), 42);
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
      assert.strictEqual(sent[sent.length - 1].data.readUInt32BE(16), 0x10000);
    });
  });
});
