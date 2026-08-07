import assert from 'node:assert/strict';
import {readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

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

      assert.strictEqual(typeof info, 'object');
      assert.strictEqual(typeof info.avcFrameworkVersion, 'string');
      assert.strictEqual(typeof info.supportedFeatures, 'number');
      assert.strictEqual(typeof info.supportedFeaturesDescription, 'string');
    });

    it('getMediaStreamServerStatus reports the server state', async function () {
      const status = await service!.getMediaStreamServerStatus();

      assert.strictEqual(typeof status, 'object');
      assert.strictEqual(typeof status.running, 'boolean');
      assert.ok(Array.isArray(status.sessions));
      assert.strictEqual(typeof status.runDurationSeconds, 'number');
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
      assert.strictEqual(await service!.isStreamingSupported(), supportedFeatures !== 0);
    });
  });

  describe('addressing', function () {
    it('resolves the host and device tunnel addresses', async function () {
      const [local, device] = await Promise.all([service!.getTunnelLocalAddress(), service!.getDeviceAddress()]);

      // Both sides of the tunnel are IPv6 and must differ.
      assert.strictEqual(typeof local, 'string');
      assert.ok(local.includes(':'));
      assert.strictEqual(typeof device, 'string');
      assert.ok(device.includes(':'));
      assert.notStrictEqual(local, device);
    });

    it('binds a UDP media receiver on an ephemeral port', async function () {
      const receiver = await UdpMediaReceiver.bind();
      try {
        assert.ok(receiver.port > 0);
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
          assert.strictEqual(streamingSupported, false, 'a device advertising support should not reject the stream');
          assert.ok(error instanceof CoreDeviceError);
          const {response} = error as CoreDeviceError;
          const deviceError = response?.['CoreDevice.error'] as Record<string, unknown> | undefined;
          assert.strictEqual(deviceError?.code, REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE);
          assert.ok((error as Error).message.includes('iOS 27'));
          return;
        }

        assert.strictEqual(streamingSupported, true);
        assert.ok(answer.clientSessionId instanceof XPCUUID);
        assert.strictEqual(typeof answer.streamConfig, 'object');
        // The device streams from its own ephemeral port back to ours.
        assert.strictEqual(answer.streamConfig.DestPort, receiver.port);
        assert.strictEqual(typeof answer.streamConfig.RemoteSSRC, 'number');

        const stopped = await service!.stopAllMediaStreams();
        // Streams are identified by their RemoteSSRC in the stop response.
        assert.ok(stopped.includes(answer.streamConfig.RemoteSSRC as number));
      } finally {
        receiver.close();
      }
    });

    it('either captures access units or reports the iOS 27 requirement', async function () {
      let capture: ScreenStreamCapture;
      try {
        capture = await ScreenStreamCapture.start(service!, {displayId: 1});
      } catch (error) {
        assert.strictEqual(streamingSupported, false);
        assert.ok(error instanceof CoreDeviceError);
        assert.ok((error as Error).message.includes('iOS 27'));
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

        assert.ok(units.length > 0, 'the device should push video once negotiated');
        assert.strictEqual(
          units.some((unit) => unit.isKeyFrame),
          true,
          'a stream must open with a keyframe',
        );
        assert.match(capture.codecString, /^hev1\./, 'the SPS should yield a codec string');
        assert.notStrictEqual(capture.parameterSets, undefined, 'VPS/SPS/PPS should all arrive');
        assert.ok(capture.decoderConfigurationRecord instanceof Buffer);
        assert.ok(capture.stats.packetsReceived > 0);
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
          assert.strictEqual(streamingSupported, false);
          assert.ok((error as Error).message.includes('iOS 27'));
          return;
        }

        assert.strictEqual(streamingSupported, true);
        // AAC-ELD at 48 kHz stereo is advertised as payload type 101.
        assert.strictEqual(answer.streamConfig.RxPayloadType, 101);
        assert.strictEqual(answer.streamConfig.AudioStreamMode, 8);
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
        assert.strictEqual(streamingSupported, false);
        assert.ok((error as Error).message.includes('iOS 27'));
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

        assert.ok(units.length > 0, 'the device streams silence frames even when idle');
        // Each unit is one 10 ms AAC-ELD frame; they are small but never empty.
        for (const unit of units.slice(0, 10)) {
          assert.ok(unit.data.length > 0);
        }
        assert.deepStrictEqual(capture.format, AAC_ELD_FORMAT);
        assert.strictEqual(capture.stats.accessUnitsEmitted, units.length);
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
          assert.strictEqual(streamingSupported, false);
          assert.ok((error as Error).message.includes('iOS 27'));
          return;
        }

        assert.ok(result.accessUnitsWritten > 0);
        assert.ok(result.bytesWritten > 0);
        // 480 frames @ 48 kHz => each access unit is exactly 10 ms.
        assert.strictEqual(result.durationMs, result.accessUnitsWritten * 10);
        assert.deepStrictEqual(result.format.audioSpecificConfig, AAC_ELD_FORMAT.audioSpecificConfig);

        const written = await stat(outputPath);
        assert.strictEqual(written.size, result.bytesWritten);

        const file = await readFile(outputPath);
        // Must be a real MP4: 'ftyp' sits at offset 4 of every MP4 file.
        assert.strictEqual(file.toString('ascii', 4, 8), 'ftyp');
        assert.strictEqual(file.toString('ascii', 8, 12), 'M4A ');

        // The esds must declare 480-sample frames. The device's own handshake
        // cookie says 512, and a file carrying that claim is rejected by every
        // standard decoder (ffmpeg errors, AudioToolbox refuses) — so this is
        // what makes the recording usable at all, and it must not regress.
        const asc = extractAudioSpecificConfig(file);
        assert.notStrictEqual(asc, undefined, 'esds should carry an AudioSpecificConfig');
        const {audioObjectType, frameLengthFlag} = parseAudioSpecificConfig(asc!);
        assert.strictEqual(audioObjectType, 39, 'AOT 39 = ER AAC ELD');
        assert.strictEqual(frameLengthFlag, 1, '1 = 480-sample frames');
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
          assert.strictEqual(streamingSupported, false);
          assert.ok((error as Error).message.includes('iOS 27'));
          return;
        }

        assert.ok(result.video.framesWritten > 0, 'video should have frames');
        assert.ok(result.audio.accessUnitsWritten > 0, 'audio should have access units');
        assert.ok(result.video.frameRate > 0);
        assert.match(result.video.codecString, /^hev1\./);

        // Both files must exist with the reported sizes.
        assert.strictEqual((await stat(videoPath)).size, result.video.bytesWritten);
        assert.strictEqual((await stat(audioPath)).size, result.audio.bytesWritten);

        // The command must reference both inputs and carry the measured rate,
        // since Annex-B has no timestamps of its own. Argument-vector form, so
        // the paths appear as whole elements rather than inside a quoted string.
        const {binary, args} = result.muxCommand;
        assert.strictEqual(binary, 'ffmpeg');
        assert.ok(args.includes(videoPath));
        assert.ok(args.includes(audioPath));
        assert.strictEqual(args[args.indexOf('-r') + 1], String(result.video.frameRate));
        assert.strictEqual(args[args.indexOf('-fflags') + 1], '+genpts');
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
          assert.strictEqual(streamingSupported, false);
          assert.ok((error as Error).message.includes('iOS 27'));
          return;
        }

        // Without RTCP receiver reports both streams stop dead at 20s: audio
        // would land at ~20.0s against a 25s window.
        assert.ok(result.audio.durationMs > 22_000, 'audio should outlive the 20s timeout');
        assert.ok(result.video.durationMs > 24_000, 'video window should be the full duration');

        // The two tracks should stay in step; a large shortfall means a session
        // was reaped.
        const skewMs = Math.abs(result.video.durationMs - result.audio.durationMs);
        assert.ok(skewMs < 2000, `video/audio duration skew was ${skewMs.toFixed(0)}ms`);

        // Video must keep flowing too — the reap affects both streams.
        assert.ok(result.video.framesWritten > 0);
        assert.strictEqual(result.video.stats.packetsLost, 0);
        assert.strictEqual(result.audio.stats.packetsLost, 0);
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
        assert.strictEqual(streamingSupported, false);
        assert.ok((error as Error).message.includes('iOS 27'));
        return;
      }

      assert.strictEqual(streamingSupported, true);
      assert.ok(result.framesWritten > 0);
      assert.ok(result.bytesWritten > 0);
      assert.match(result.codecString, /^hev1\./);

      const written = await stat(outputPath);
      assert.strictEqual(written.size, result.bytesWritten);
    });
  });
});
