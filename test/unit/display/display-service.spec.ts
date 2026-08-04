import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';
import {inflateSync} from 'node:zlib';

import {parseBinaryPlist} from '../../../src/lib/plist/binary-plist-parser.js';
import {XPC_TYPES, decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import {XPCUUID} from '../../../src/lib/remote-xpc/xpc-uuid.js';
import type {XPCDictionary} from '../../../src/lib/types.js';
import {CoreDeviceError} from '../../../src/services/ios/core-device/core-device-service.js';
import {DisplayService} from '../../../src/services/ios/display/index.js';

type Responder = (sentBody: XPCDictionary) => XPCDictionary | null;

const LOCAL_ADDRESS = 'fd02:1caa:f094::2';

/**
 * Fake framed transport: captures every sent XPC body and emits a canned reply
 * on the next microtask, mirroring a device response.
 */
class FakeTransport extends EventEmitter {
  isConnected = true;
  closeCalls = 0;
  readonly localAddress = LOCAL_ADDRESS;
  readonly sentBodies: XPCDictionary[] = [];
  /**
   * Raw encoded frames. The decoder normalizes int64/uint64 to `number` and
   * UUIDs to hex strings, so the wire *type* is only observable here.
   */
  readonly sentPayloads: Buffer[] = [];

  constructor(private responder: Responder) {
    super();
  }

  sendDataFrame(payload: Buffer): void {
    this.sentPayloads.push(payload);
    const {message} = decodeMessage(payload);
    const body = message.body as XPCDictionary;
    this.sentBodies.push(body);
    const reply = this.responder(body);
    if (reply) {
      queueMicrotask(() => this.emit('message', reply));
    }
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }
}

/** Returns whether `payload` encodes `uuid` using the XPC uuid type tag. */
function containsXpcUuid(payload: Buffer, uuid: XPCUUID): boolean {
  const typeTag = Buffer.alloc(4);
  typeTag.writeUInt32LE(XPC_TYPES.uuid, 0);
  return payload.includes(Buffer.concat([typeTag, uuid.uuidBytes]));
}

/** Returns whether `payload` encodes `value` using the XPC uint64 type tag. */
function containsXpcUint64(payload: Buffer, value: bigint): boolean {
  const encoded = Buffer.alloc(12);
  encoded.writeUInt32LE(XPC_TYPES.uint64, 0);
  encoded.writeBigUInt64LE(value, 4);
  return payload.includes(encoded);
}

class TestDisplayService extends DisplayService {
  constructor(readonly fake: FakeTransport) {
    super('test-udid');
  }

  protected async createTransport(): Promise<any> {
    return this.fake;
  }

  protected async resolveServiceAddress(): Promise<[string, number]> {
    return ['fd02:1caa:f094::1', 49832];
  }
}

/** Wraps `output` the way the device wraps a CoreDevice invocation reply. */
function coreDeviceOutput(output: XPCDictionary): XPCDictionary {
  return {'CoreDevice.output': output};
}

const ENDPOINT = {
  receiverIp: LOCAL_ADDRESS,
  receiverPort: 51234,
  senderIp: 'fd02:1caa:f094::1',
};

describe('DisplayService', function () {
  describe('capability queries', function () {
    it('getMediaSupportInfo invokes the support-info feature and returns the output', async function () {
      const info = {supportedFeatures: 0, avcFrameworkVersion: '2205.3.1.1'};
      const fake = new FakeTransport(() => coreDeviceOutput(info));
      const service = new TestDisplayService(fake);

      const result = await service.getMediaSupportInfo();

      assert.strictEqual(
        fake.sentBodies[0]['CoreDevice.featureIdentifier'],
        'com.apple.coredevice.feature.getmediasupportinfo',
      );
      assert.strictEqual(
        fake.sentBodies[0]['CoreDevice.actionIdentifier'],
        'com.apple.coredevice.action.mediastreamgetsupportinfo',
      );
      assert.deepStrictEqual(result, info);
    });

    it('getMediaStreamServerStatus invokes the status feature', async function () {
      const status: XPCDictionary = {running: false, sessions: [], runDurationSeconds: 0};
      const fake = new FakeTransport(() => coreDeviceOutput(status));
      const service = new TestDisplayService(fake);

      const result = await service.getMediaStreamServerStatus();

      assert.strictEqual(
        fake.sentBodies[0]['CoreDevice.featureIdentifier'],
        'com.apple.coredevice.feature.getmediastreamserverstatus',
      );
      assert.deepStrictEqual(result, status);
    });

    it('isStreamingSupported is false when the device reports no features', async function () {
      // This is what every device below iOS 27 returns.
      const fake = new FakeTransport(() => coreDeviceOutput({supportedFeatures: 0}));
      const service = new TestDisplayService(fake);

      assert.strictEqual(await service.isStreamingSupported(), false);
    });

    it('isStreamingSupported is true for a non-zero feature mask', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({supportedFeatures: 140}));
      const service = new TestDisplayService(fake);

      assert.strictEqual(await service.isStreamingSupported(), true);
    });

    it('isStreamingSupported is false when the field is missing entirely', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({}));
      const service = new TestDisplayService(fake);

      assert.strictEqual(await service.isStreamingSupported(), false);
    });
  });

  describe('startVideoStream', function () {
    function startResponder(): Responder {
      return () =>
        coreDeviceOutput({
          connection: {
            streamConfig: {RxPayloadType: 123, SourcePort: 61000},
            options: {},
          },
        });
    }

    it('sends the endpoint, negotiator offer and video options', async function () {
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      await service.startVideoStream(ENDPOINT, {displayId: 2});

      const body = fake.sentBodies[0];
      assert.strictEqual(body['CoreDevice.featureIdentifier'], 'com.apple.coredevice.feature.startmediastream');
      assert.strictEqual(body['CoreDevice.actionIdentifier'], 'com.apple.coredevice.action.mediastreamstart');

      const input = body['CoreDevice.input'] as XPCDictionary;
      assert.strictEqual(input.type, 'video');
      assert.strictEqual(input.direction, 'output');
      assert.strictEqual(input.receiverIP, ENDPOINT.receiverIp);
      assert.strictEqual(input.receiverPort, ENDPOINT.receiverPort);
      assert.strictEqual(input.senderIP, ENDPOINT.senderIp);
      assert.strictEqual(input.timeout, 20);
      assert.strictEqual(input.clientSupportedFeatures, 140);

      const options = input.options as XPCDictionary;
      assert.deepStrictEqual(options.CoreDeviceVideoDisplayMode, {string: 'DisplayByID'});
      assert.deepStrictEqual(options.VideoStreamForDisplayID, {int: 2});
    });

    it('encodes the port, timeout and feature mask as XPC uint64 values', function (_t, done) {
      // The daemon rejects these as int64; the decoder collapses both to
      // `number`, so the wire tag has to be checked on the raw frame.
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      service
        .startVideoStream(ENDPOINT)
        .then(() => {
          const payload = fake.sentPayloads[0];
          assert.strictEqual(containsXpcUint64(payload, BigInt(ENDPOINT.receiverPort)), true);
          assert.strictEqual(containsXpcUint64(payload, 20n), true); // timeout
          assert.strictEqual(containsXpcUint64(payload, 140n), true); // clientSupportedFeatures
          done();
        })
        .catch(done);
    });

    it('defaults to display 1', async function () {
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      await service.startVideoStream(ENDPOINT);

      const input = fake.sentBodies[0]['CoreDevice.input'] as XPCDictionary;
      assert.deepStrictEqual((input.options as XPCDictionary).VideoStreamForDisplayID, {int: 1});
    });

    it('carries a mode-5 negotiator offer that inflates to a valid mediaBlob', async function () {
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      await service.startVideoStream(ENDPOINT);

      const input = fake.sentBodies[0]['CoreDevice.input'] as XPCDictionary;
      const offer = parseBinaryPlist(input.negotiatorOffer as Buffer) as Record<string, unknown>;
      assert.strictEqual(offer.avcMediaStreamNegotiatorMode, 5);
      assert.doesNotThrow(() => inflateSync(offer.avcMediaStreamNegotiatorMediaBlob as Buffer));
    });

    it('sends the session id as an XPC UUID and returns it', async function () {
      const sessionId = XPCUUID.random();
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      const answer = await service.startVideoStream(ENDPOINT, {clientSessionId: sessionId});

      // Must be the XPC uuid type, not data or a string — the daemon rejects
      // anything else in this slot.
      assert.strictEqual(containsXpcUuid(fake.sentPayloads[0], sessionId), true);
      assert.strictEqual(answer.clientSessionId.toString(), sessionId.toString());
    });

    it('generates a session id when none is supplied', async function () {
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      const answer = await service.startVideoStream(ENDPOINT);

      assert.ok(answer.clientSessionId instanceof XPCUUID);
    });

    it("prefers the session id echoed back in the device's answer", async function () {
      const echoed = XPCUUID.random();
      const fake = new FakeTransport(() =>
        coreDeviceOutput({
          connection: {
            options: {
              // The decoder surfaces a UUID as bare hex, as a real reply would.
              avcMediaStreamOptionClientSessionID: {uuid: echoed.uuidBytes.toString('hex')},
            },
          },
        }),
      );
      const service = new TestDisplayService(fake);

      const answer = await service.startVideoStream(ENDPOINT, {clientSessionId: XPCUUID.random()});

      assert.strictEqual(answer.clientSessionId.toString(), echoed.toString());
    });

    it('surfaces the negotiated stream config', async function () {
      const fake = new FakeTransport(startResponder());
      const service = new TestDisplayService(fake);

      const answer = await service.startVideoStream(ENDPOINT);

      assert.deepStrictEqual(answer.streamConfig, {RxPayloadType: 123, SourcePort: 61000});
    });

    it('propagates the iOS 27 gate as a CoreDeviceError', async function () {
      // What an iOS 26 device actually replies with.
      const fake = new FakeTransport(() => ({
        'CoreDevice.error': {
          code: 9021,
          domain: 'com.apple.dt.CoreDeviceError',
          userInfo: {
            NSLocalizedDescription: 'Remote control requires iOS 27.0 or later on this device.',
          },
        },
      }));
      const service = new TestDisplayService(fake);

      let caught: unknown;
      try {
        await service.startVideoStream(ENDPOINT);
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof CoreDeviceError);
      assert.ok((caught as Error).message.includes('Remote control requires iOS 27.0 or later'));
    });
  });

  describe('startAudioStream', function () {
    it('sends a mode-6 offer with no video-only options', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({connection: {}}));
      const service = new TestDisplayService(fake);

      await service.startAudioStream(ENDPOINT);

      const input = fake.sentBodies[0]['CoreDevice.input'] as XPCDictionary;
      assert.strictEqual(input.type, 'audio');
      const options = input.options as XPCDictionary;
      assert.ok(!('CoreDeviceVideoDisplayMode' in options));
      assert.ok(!('VideoStreamForDisplayID' in options));

      const offer = parseBinaryPlist(input.negotiatorOffer as Buffer) as Record<string, unknown>;
      assert.strictEqual(offer.avcMediaStreamNegotiatorMode, 6);
    });

    it('accepts the video stream session id so the two are grouped', async function () {
      const shared = XPCUUID.random();
      const fake = new FakeTransport(() => coreDeviceOutput({connection: {}}));
      const service = new TestDisplayService(fake);

      await service.startAudioStream(ENDPOINT, {clientSessionId: shared});

      assert.strictEqual(containsXpcUuid(fake.sentPayloads[0], shared), true);
    });
  });

  describe('stopAllMediaStreams', function () {
    it('sends stopAll as a plain boolean true', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({stoppedStreams: []}));
      const service = new TestDisplayService(fake);

      await service.stopAllMediaStreams();

      const body = fake.sentBodies[0];
      assert.strictEqual(body['CoreDevice.featureIdentifier'], 'com.apple.coredevice.feature.stopmediastream');
      assert.strictEqual(body['CoreDevice.actionIdentifier'], 'com.apple.coredevice.action.mediastreamstop');
      // iOS 27 rejects a missing key ("Expected to find key stopAll"), a
      // wrapped value ("Expected to decode Bool but found a OS_xpc_dictionary")
      // and `false` ("Invalid request sent"). Only a bare `true` works.
      assert.deepStrictEqual(body['CoreDevice.input'], {stopAll: true});
    });

    it('returns the stopped streams ids', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({stoppedStreams: [2118279489, 3267750034]}));
      const service = new TestDisplayService(fake);

      assert.deepStrictEqual(await service.stopAllMediaStreams(), [2118279489, 3267750034]);
    });

    it('returns an empty array when the device reports no streams', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({serverInfo: {running: false}}));
      const service = new TestDisplayService(fake);

      assert.deepStrictEqual(await service.stopAllMediaStreams(), []);
    });

    it('treats the channel closing as success', async function () {
      // Some versions tear the RemoteXPC channel down while handling the stop,
      // so the reply is lost. That must not surface as a failure. The event is
      // emitted from the responder because the service only attaches its
      // listeners once the request has been written.
      const fake: FakeTransport = new FakeTransport(() => {
        queueMicrotask(() => fake.emit('close'));
        return null;
      });
      const service = new TestDisplayService(fake);

      assert.deepStrictEqual(await service.stopAllMediaStreams(), []);
    });

    it('still propagates unrelated failures', async function () {
      const fake: FakeTransport = new FakeTransport(() => {
        queueMicrotask(() => fake.emit('error', new Error('tunnel exploded')));
        return null;
      });
      const service = new TestDisplayService(fake);

      let caught: unknown;
      try {
        await service.stopAllMediaStreams();
      } catch (error) {
        caught = error;
      }

      assert.strictEqual((caught as Error | undefined)?.message, 'tunnel exploded');
    });
  });

  describe('addressing', function () {
    it('reports the host tunnel address for the media receiver', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({}));
      const service = new TestDisplayService(fake);

      assert.strictEqual(await service.getTunnelLocalAddress(), LOCAL_ADDRESS);
    });

    it('reports the device address as the RTP sender', async function () {
      const fake = new FakeTransport(() => coreDeviceOutput({}));
      const service = new TestDisplayService(fake);

      assert.strictEqual(await service.getDeviceAddress(), 'fd02:1caa:f094::1');
    });
  });
});
