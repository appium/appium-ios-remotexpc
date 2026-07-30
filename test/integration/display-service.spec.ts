import {rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import {expect} from 'chai';

import {
  CoreDeviceError,
  type DisplayService,
  REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE,
  ScreenStreamCapture,
  UdpMediaReceiver,
  XPCUUID,
  recordScreenToFile,
} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the CoreDevice display service
 * (`com.apple.coredevice.displayservice`) — live HEVC screen and system-audio
 * streaming over RTP.
 *
 * Requires a physical iOS device with a running tunnel registry. Set the UDID
 * env var to the target device.
 *
 * **Streaming requires iOS 27.0 or later.** On older devices the daemon still
 * answers the capability queries but rejects every start-stream request with
 * `CoreDeviceError` 9021 ("Remote control requires iOS 27.0 or later on this
 * device"). The streaming tests below detect that and assert the rejection is
 * surfaced cleanly instead of failing, so the suite is meaningful on both
 * sides of the version gate.
 */
describe('DisplayService', {timeout: 120000}, function () {
  let service: DisplayService | null = null;
  let streamingSupported = false;

  before(async function () {
    const udid = requireDeviceUdid();
    service = await Services.startDisplayService(udid);
    streamingSupported = await service.isStreamingSupported();
  });

  after(async function () {
    try {
      await service?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  describe('capability queries', function () {
    it('getMediaSupportInfo reports the AVConference framework version', async function () {
      const info = await service!.getMediaSupportInfo();

      expect(info).to.be.an('object');
      expect(info.avcFrameworkVersion).to.be.a('string');
      expect(info.supportedFeatures).to.be.a('number');
      expect(info.supportedFeaturesDescription).to.be.a('string');
    });

    it('getMediaStreamServerStatus reports the server state', async function () {
      const status = await service!.getMediaStreamServerStatus();

      expect(status).to.be.an('object');
      expect(status.running).to.be.a('boolean');
      expect(status.sessions).to.be.an('array');
      expect(status.runDurationSeconds).to.be.a('number');
    });

    it('isStreamingSupported agrees with the reported feature mask', async function (t) {
      const {supportedFeatures} = await service!.getMediaSupportInfo();

      // Records which branch the streaming tests below will take.
      t.diagnostic(
        streamingSupported
          ? `device supports media streaming (feature mask ${supportedFeatures})`
          : 'device does not advertise media streaming (needs iOS 27+); ' +
              'the streaming tests assert the rejection path instead',
      );
      expect(await service!.isStreamingSupported()).to.equal(supportedFeatures !== 0);
    });
  });

  describe('addressing', function () {
    it('resolves the host and device tunnel addresses', async function () {
      const [local, device] = await Promise.all([service!.getTunnelLocalAddress(), service!.getDeviceAddress()]);

      // Both sides of the tunnel are IPv6 and must differ.
      expect(local).to.be.a('string').and.contain(':');
      expect(device).to.be.a('string').and.contain(':');
      expect(local).to.not.equal(device);
    });

    it('binds a UDP media receiver on an ephemeral port', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        expect(receiver.port).to.be.greaterThan(0);
      } finally {
        receiver.close();
      }
    });
  });

  describe('video stream negotiation', function () {
    it('either negotiates a stream or reports the iOS 27 requirement', async function () {
      const receiver = await UdpMediaReceiver.bind();
      const sessionId = XPCUUID.random();
      try {
        const [receiverIp, senderIp] = await Promise.all([
          service!.getTunnelLocalAddress(),
          service!.getDeviceAddress(),
        ]);

        let answer;
        try {
          answer = await service!.startVideoStream(
            {receiverIp, receiverPort: receiver.port, senderIp},
            {clientSessionId: sessionId},
          );
        } catch (error) {
          expect(streamingSupported, 'a device advertising support should not reject the stream').to.equal(false);
          expect(error).to.be.instanceOf(CoreDeviceError);
          const {response} = error as CoreDeviceError;
          const deviceError = response?.['CoreDevice.error'] as Record<string, unknown> | undefined;
          expect(deviceError?.code).to.equal(REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE);
          expect((error as Error).message).to.contain('iOS 27');
          return;
        }

        expect(streamingSupported).to.equal(true);
        expect(answer.clientSessionId).to.be.instanceOf(XPCUUID);
        expect(answer.streamConfig).to.be.an('object');
        // The device streams from its own ephemeral port back to ours.
        expect(answer.streamConfig.DestPort).to.equal(receiver.port);
        expect(answer.streamConfig.RemoteSSRC).to.be.a('number');

        const stopped = await service!.stopAllMediaStreams();
        // Streams are identified by their RemoteSSRC in the stop response.
        expect(stopped).to.include(answer.streamConfig.RemoteSSRC);
      } finally {
        receiver.close();
      }
    });

    it('either captures access units or reports the iOS 27 requirement', async function () {
      let capture: ScreenStreamCapture;
      try {
        capture = await ScreenStreamCapture.start(service!, {displayId: 1});
      } catch (error) {
        expect(streamingSupported).to.equal(false);
        expect(error).to.be.instanceOf(CoreDeviceError);
        expect((error as Error).message).to.contain('iOS 27');
        return;
      }

      try {
        const units = [];
        const deadline = performance.now() + 5000;
        for await (const unit of capture.accessUnits()) {
          units.push(unit);
          if (units.length >= 10 || performance.now() > deadline) {
            break;
          }
        }

        expect(units.length, 'the device should push video once negotiated').to.be.greaterThan(0);
        expect(
          units.some((unit) => unit.isKeyFrame),
          'a stream must open with a keyframe',
        ).to.equal(true);
        expect(capture.codecString, 'the SPS should yield a codec string').to.match(/^hev1\./);
        expect(capture.parameterSets, 'VPS/SPS/PPS should all arrive').to.not.equal(undefined);
        expect(capture.decoderConfigurationRecord).to.be.instanceOf(Buffer);
        expect(capture.stats.packetsReceived).to.be.greaterThan(0);
      } finally {
        await capture.stop();
      }
    });
  });

  describe('audio stream negotiation', function () {
    it('either negotiates system audio or reports the iOS 27 requirement', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        const [receiverIp, senderIp] = await Promise.all([
          service!.getTunnelLocalAddress(),
          service!.getDeviceAddress(),
        ]);

        let answer;
        try {
          answer = await service!.startAudioStream({receiverIp, receiverPort: receiver.port, senderIp});
        } catch (error) {
          expect(streamingSupported).to.equal(false);
          expect((error as Error).message).to.contain('iOS 27');
          return;
        }

        expect(streamingSupported).to.equal(true);
        // AAC-ELD at 48 kHz stereo is advertised as payload type 101.
        expect(answer.streamConfig.RxPayloadType).to.equal(101);
        expect(answer.streamConfig.AudioStreamMode).to.equal(8);
        await service!.stopAllMediaStreams();
      } finally {
        receiver.close();
      }
    });
  });

  describe('recording', function () {
    const outputPath = join(tmpdir(), `remotexpc-screen-${process.pid}.h265`);

    after(async function () {
      await rm(outputPath, {force: true});
    });

    it('either records a playable elementary stream or reports the iOS 27 requirement', async function () {
      let result;
      try {
        result = await recordScreenToFile(service!, outputPath, {durationMs: 4000});
      } catch (error) {
        expect(streamingSupported).to.equal(false);
        expect((error as Error).message).to.contain('iOS 27');
        return;
      }

      expect(streamingSupported).to.equal(true);
      expect(result.framesWritten).to.be.greaterThan(0);
      expect(result.bytesWritten).to.be.greaterThan(0);
      expect(result.codecString).to.match(/^hev1\./);

      const written = await stat(outputPath);
      expect(written.size).to.equal(result.bytesWritten);
    });
  });
});
