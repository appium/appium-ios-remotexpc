import {readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import {expect} from 'chai';

import {
  AAC_ELD_FORMAT,
  AudioStreamCapture,
  CoreDeviceError,
  type DisplayService,
  REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE,
  ScreenStreamCapture,
  UdpMediaReceiver,
  XPCUUID,
  recordAudioToFile,
  recordScreenAndAudioToFiles,
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
/**
 * Pulls the AudioSpecificConfig out of an MP4's `esds` box by walking the
 * MPEG-4 descriptor chain: ES_Descriptor (0x03) -> DecoderConfigDescriptor
 * (0x04) -> DecoderSpecificInfo (0x05), whose payload is the config.
 */
function extractAudioSpecificConfig(file: Buffer): Buffer | undefined {
  const esdsIndex = file.indexOf('esds', 0, 'ascii');
  if (esdsIndex < 0) {
    return undefined;
  }
  // Skip the box type and its 4-byte version/flags to reach the descriptors.
  let offset = esdsIndex + 4 + 4;

  const readLength = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = file[offset++];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        break;
      }
    }
    return value;
  };

  while (offset < file.length) {
    const tag = file[offset++];
    const length = readLength();
    if (tag === 0x05) {
      return file.subarray(offset, offset + length);
    }
    if (tag === 0x03) {
      offset += 3; // ES_ID (2) + flags (1), then nested descriptors follow
      continue;
    }
    if (tag === 0x04) {
      offset += 13; // objectTypeIndication, streamType, buffer/bitrate fields
      continue;
    }
    offset += length; // an descriptor we do not need to descend into
  }
  return undefined;
}

/** Reads the leading fields of an AudioSpecificConfig. */
function parseAudioSpecificConfig(asc: Buffer): {audioObjectType: number; frameLengthFlag: number} {
  const bits = [...asc].map((b) => b.toString(2).padStart(8, '0')).join('');
  let pos = 0;
  const take = (n: number): number => {
    const value = parseInt(bits.slice(pos, pos + n), 2);
    pos += n;
    return value;
  };
  let audioObjectType = take(5);
  if (audioObjectType === 31) {
    audioObjectType = 32 + take(6);
  }
  take(4); // samplingFrequencyIndex
  take(4); // channelConfiguration
  return {audioObjectType, frameLengthFlag: take(1)};
}

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

  describe('audio capture', function () {
    it('either captures AAC-ELD access units or reports the iOS 27 requirement', async function () {
      let capture: AudioStreamCapture;
      try {
        capture = await AudioStreamCapture.start(service!);
      } catch (error) {
        expect(streamingSupported).to.equal(false);
        expect((error as Error).message).to.contain('iOS 27');
        return;
      }

      try {
        const units = [];
        const deadline = performance.now() + 5000;
        for await (const unit of capture.accessUnits()) {
          units.push(unit);
          if (units.length >= 50 || performance.now() > deadline) {
            break;
          }
        }

        expect(units.length, 'the device streams silence frames even when idle').to.be.greaterThan(0);
        // Each unit is one 10 ms AAC-ELD frame; they are small but never empty.
        for (const unit of units.slice(0, 10)) {
          expect(unit.data.length).to.be.greaterThan(0);
        }
        expect(capture.format).to.deep.equal(AAC_ELD_FORMAT);
        expect(capture.stats.accessUnitsEmitted).to.equal(units.length);
      } finally {
        await capture.stop();
      }
    });

    it('either records a playable .m4a or reports the iOS 27 requirement', async function () {
      const outputPath = join(tmpdir(), `remotexpc-audio-${process.pid}.m4a`);
      try {
        let result;
        try {
          result = await recordAudioToFile(service!, outputPath, {durationMs: 3000});
        } catch (error) {
          expect(streamingSupported).to.equal(false);
          expect((error as Error).message).to.contain('iOS 27');
          return;
        }

        expect(result.accessUnitsWritten).to.be.greaterThan(0);
        expect(result.bytesWritten).to.be.greaterThan(0);
        // 480 frames @ 48 kHz => each access unit is exactly 10 ms.
        expect(result.durationMs).to.equal(result.accessUnitsWritten * 10);
        expect(result.format.audioSpecificConfig).to.deep.equal(AAC_ELD_FORMAT.audioSpecificConfig);

        const written = await stat(outputPath);
        expect(written.size).to.equal(result.bytesWritten);

        const file = await readFile(outputPath);
        // Must be a real MP4: 'ftyp' sits at offset 4 of every MP4 file.
        expect(file.toString('ascii', 4, 8)).to.equal('ftyp');
        expect(file.toString('ascii', 8, 12)).to.equal('M4A ');

        // The esds must declare 480-sample frames. The device's own handshake
        // cookie says 512, and a file carrying that claim is rejected by every
        // standard decoder (ffmpeg errors, AudioToolbox refuses) — so this is
        // what makes the recording usable at all, and it must not regress.
        const asc = extractAudioSpecificConfig(file);
        expect(asc, 'esds should carry an AudioSpecificConfig').to.not.equal(undefined);
        const {audioObjectType, frameLengthFlag} = parseAudioSpecificConfig(asc!);
        expect(audioObjectType, 'AOT 39 = ER AAC ELD').to.equal(39);
        expect(frameLengthFlag, '1 = 480-sample frames').to.equal(1);
      } finally {
        await rm(outputPath, {force: true});
      }
    });
  });

  describe('combined A/V recording', function () {
    it('either writes both tracks plus a mux command or reports the iOS 27 requirement', async function () {
      const videoPath = join(tmpdir(), `remotexpc-av-${process.pid}.h265`);
      const audioPath = join(tmpdir(), `remotexpc-av-${process.pid}.m4a`);
      try {
        let result;
        try {
          result = await recordScreenAndAudioToFiles(service!, {videoPath, audioPath, durationMs: 5000});
        } catch (error) {
          expect(streamingSupported).to.equal(false);
          expect((error as Error).message).to.contain('iOS 27');
          return;
        }

        expect(result.video.framesWritten, 'video should have frames').to.be.greaterThan(0);
        expect(result.audio.accessUnitsWritten, 'audio should have access units').to.be.greaterThan(0);
        expect(result.video.frameRate).to.be.greaterThan(0);
        expect(result.video.codecString).to.match(/^hev1\./);

        // Both files must exist with the reported sizes.
        expect((await stat(videoPath)).size).to.equal(result.video.bytesWritten);
        expect((await stat(audioPath)).size).to.equal(result.audio.bytesWritten);

        // The command must reference both inputs and carry the measured rate,
        // since Annex-B has no timestamps of its own.
        expect(result.ffmpegCommand).to.contain(videoPath);
        expect(result.ffmpegCommand).to.contain(audioPath);
        expect(result.ffmpegCommand).to.contain(`-r ${result.video.frameRate}`);
        expect(result.ffmpegCommand).to.contain('-fflags +genpts');
      } finally {
        await rm(videoPath, {force: true});
        await rm(audioPath, {force: true});
      }
    });
  });

  describe('long recordings', function () {
    // NOTE: this test deliberately records for 25s and so dominates the suite's
    // runtime (the rest finishes in a few seconds). That length is the point:
    // the device reaps a media session at its RTCPTimeoutInterval of 20s unless
    // receiver reports keep arriving, so nothing shorter can detect a broken
    // keepalive. Every other test here would still pass with RTCP entirely
    // removed. Do not shorten it below ~22s.
    it('either keeps audio alive past the 20s RTCP timeout or reports the iOS 27 requirement', async function () {
      const videoPath = join(tmpdir(), `remotexpc-long-${process.pid}.h265`);
      const audioPath = join(tmpdir(), `remotexpc-long-${process.pid}.m4a`);
      try {
        let result;
        try {
          result = await recordScreenAndAudioToFiles(service!, {videoPath, audioPath, durationMs: 25_000});
        } catch (error) {
          expect(streamingSupported).to.equal(false);
          expect((error as Error).message).to.contain('iOS 27');
          return;
        }

        // Without RTCP receiver reports both streams stop dead at 20s: audio
        // would land at ~20.0s against a 25s window.
        expect(result.audio.durationMs, 'audio should outlive the 20s timeout').to.be.greaterThan(22_000);
        expect(result.video.durationMs, 'video window should be the full duration').to.be.greaterThan(24_000);

        // The two tracks should stay in step; a large shortfall means a session
        // was reaped.
        const skewMs = Math.abs(result.video.durationMs - result.audio.durationMs);
        expect(skewMs, `video/audio duration skew was ${skewMs.toFixed(0)}ms`).to.be.lessThan(2000);

        // Video must keep flowing too — the reap affects both streams.
        expect(result.video.framesWritten).to.be.greaterThan(0);
        expect(result.video.stats.packetsLost).to.equal(0);
        expect(result.audio.stats.packetsLost).to.equal(0);
      } finally {
        await rm(videoPath, {force: true});
        await rm(audioPath, {force: true});
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
