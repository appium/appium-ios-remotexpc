import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DataFrame} from '../../../src/lib/remote-xpc/handshake-frames.js';
import {Http2FrameParser, buildWindowUpdateFrames} from '../../../src/lib/remote-xpc/http2-frame-parser.js';
import {ServiceCatalogCollector, servicesFromXpcBody} from '../../../src/lib/remote-xpc/service-catalog.js';
import {encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import {buildUndecodableMessage} from './xpc-fixtures.js';

function buildCatalogXpcPayload(serviceCount: number): Buffer {
  const services: Record<string, {Port: string}> = {};
  for (let i = 0; i < serviceCount; i++) {
    services[`com.apple.example.service_${i}`] = {Port: String(52000 + i)};
  }
  services['com.apple.mobile.diagnostics_relay.shim.remote'] = {
    Port: '59999',
  };

  return encodeMessage({
    flags: 0x00000001,
    id: BigInt(0),
    body: {
      MessageType: 'Handshake',
      Services: services,
    },
  });
}

describe('RSD service catalog discovery', function () {
  describe('servicesFromXpcBody', function () {
    it('extracts all services including late-alphabet names', function () {
      const body = {
        Services: {
          'com.apple.afc.shim.remote': {Port: '52280'},
          'com.apple.mobile.diagnostics_relay.shim.remote': {
            Port: '52299',
          },
        },
      };

      const result = servicesFromXpcBody(body);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result!.services.length, 2);
      assert.strictEqual(
        result!.services.find((s) => s.serviceName === 'com.apple.mobile.diagnostics_relay.shim.remote')?.port,
        '52299',
      );
    });

    it('returns null when Services is missing', function () {
      assert.strictEqual(servicesFromXpcBody({MessageType: 'Handshake'}), null);
    });
  });

  describe('ServiceCatalogCollector', function () {
    it('does not settle until the full XPC message arrives', function () {
      const payload = buildCatalogXpcPayload(45);
      const splitAt = Math.floor(payload.length / 3);
      const collector = new ServiceCatalogCollector();

      assert.strictEqual(collector.ingestDataPayload(payload.subarray(0, splitAt)), null);
      assert.notStrictEqual(collector.ingestDataPayload(payload.subarray(splitAt)), null);
    });

    it('parses multiple back-to-back XPC messages in one chunk', function () {
      const prelude = encodeMessage({
        flags: 0x0201,
        id: BigInt(0),
        body: null,
      });
      const catalog = buildCatalogXpcPayload(3);
      const collector = new ServiceCatalogCollector();

      const result = collector.ingestDataPayload(Buffer.concat([prelude, catalog]));

      assert.notStrictEqual(result, null);
      assert.strictEqual(
        result!.services.some((s) => s.serviceName === 'com.apple.mobile.diagnostics_relay.shim.remote'),
        true,
      );
    });

    it('preserves trailing bytes after a decoded non-catalog message', function () {
      const prelude = encodeMessage({
        flags: 0x0201,
        id: BigInt(0),
        body: {MessageType: 'Handshake'},
      });
      const catalog = buildCatalogXpcPayload(2);
      const collector = new ServiceCatalogCollector();

      assert.strictEqual(collector.ingestDataPayload(prelude.subarray(0, prelude.length - 4)), null);
      assert.notStrictEqual(
        collector.ingestDataPayload(Buffer.concat([prelude.subarray(prelude.length - 4), catalog])),
        null,
      );
    });

    it('skips an undecodable message and still returns the catalog behind it', function () {
      const collector = new ServiceCatalogCollector();

      const result = collector.ingestDataPayload(
        Buffer.concat([buildUndecodableMessage(1), buildCatalogXpcPayload(2)]),
      );

      assert.notStrictEqual(result, null);
      assert.ok(result!.services.length >= 2);
    });

    it('throws once the stream desyncs rather than reporting "not yet"', function () {
      const collector = new ServiceCatalogCollector();

      assert.throws(
        () => collector.ingestDataPayload(Buffer.concat([Buffer.alloc(32, 0xab), buildCatalogXpcPayload(1)])),
        /Invalid XPC wrapper magic/,
      );
    });

    it('keeps throwing once desynced rather than resuming mid-message', function () {
      const collector = new ServiceCatalogCollector();

      assert.throws(() => collector.ingestDataPayload(Buffer.alloc(32, 0xab)), /Invalid XPC wrapper magic/);
      assert.throws(() => collector.ingestDataPayload(buildCatalogXpcPayload(1)), /desynced/);
    });

    it('returns the complete catalog across many TCP-sized chunks', function () {
      const payload = buildCatalogXpcPayload(50);
      const collector = new ServiceCatalogCollector();
      const chunkSize = 512;
      let result = null;

      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        const chunk = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
        result = collector.ingestDataPayload(chunk) ?? result;
      }

      assert.notStrictEqual(result, null);
      assert.ok(result!.services.length >= 50);
      assert.strictEqual(
        result!.services.some((s) => s.serviceName === 'com.apple.mobile.diagnostics_relay.shim.remote'),
        true,
      );
    });
  });

  describe('Http2FrameParser', function () {
    it('rejects DATA frames whose padding exceeds the payload', function () {
      const parser = new Http2FrameParser();
      // PADDED flag (0x08), 1-byte body: pad length 0 with no room for data
      const header = Buffer.alloc(9);
      header[2] = 1; // length = 1
      header[3] = 0x00; // DATA
      header[4] = 0x08; // PADDED
      header.writeUInt32BE(1, 5); // stream 1
      const body = Buffer.from([5]); // pad length 5 >= body length 1

      assert.throws(() => parser.append(Buffer.concat([header, body])), /PROTOCOL_ERROR: Padding exceeds frame size/);
    });

    it('reassembles a DATA frame split across multiple socket reads', function () {
      const xpcPayload = buildCatalogXpcPayload(5);
      const dataFrame = new DataFrame(1, xpcPayload, []).serialize();
      const parser = new Http2FrameParser();

      const mid = Math.floor(dataFrame.length / 2);
      const first = parser.append(dataFrame.subarray(0, mid));
      const second = parser.append(dataFrame.subarray(mid));

      assert.strictEqual(first.length, 0);
      assert.strictEqual(second.length, 1);
      assert.strictEqual(second[0].type, 'data');
      assert.strictEqual(second[0].type === 'data' && second[0].frame.data.length, xpcPayload.length);
    });
  });

  describe('buildWindowUpdateFrames', function () {
    it('emits window updates for even-numbered streams', function () {
      const frames = buildWindowUpdateFrames(2, 1024);
      assert.strictEqual(frames.length, 2);
    });

    it('skips window updates for odd-numbered streams', function () {
      assert.strictEqual(buildWindowUpdateFrames(1, 1024).length, 0);
    });
  });
});
