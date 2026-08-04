import {once} from 'node:events';
import {createWriteStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';

import {getLogger} from '../../../lib/logger.js';
import {XPCUUID} from '../../../lib/remote-xpc/xpc-uuid.js';
import {type AacEldFormat, aacEldDurationMs} from './aac-eld.js';
import {AudioStreamCapture, type AudioStreamStats} from './audio-stream-capture.js';
import {toAnnexB} from './hevc.js';
import {type DisplayService, type StartVideoStreamOptions} from './index.js';
import {buildM4a} from './m4a-writer.js';
import {ScreenStreamCapture, type ScreenStreamStats} from './screen-stream-capture.js';

const log = getLogger('AvCapture');

/** Options for {@link recordScreenAndAudioToFiles}. */
export interface RecordScreenAndAudioOptions extends StartVideoStreamOptions {
  /** Where to write the Annex-B HEVC video. */
  videoPath: string;
  /** Where to write the AAC-ELD audio as `.m4a`. */
  audioPath: string;
  /** How long to record, in milliseconds. Defaults to 10000. */
  durationMs?: number;
}

/** What {@link recordScreenAndAudioToFiles} produced. */
export interface RecordScreenAndAudioResult {
  /** The video track. */
  video: {
    /** Where the Annex-B elementary stream was written. */
    path: string;
    /** Access units (frames) written. */
    framesWritten: number;
    /** Bytes written. */
    bytesWritten: number;
    /** How long the video capture window actually lasted, in milliseconds. */
    durationMs: number;
    /**
     * Measured frame rate — frames divided by the capture window.
     *
     * An Annex-B stream carries no timing, so a muxer must be told the rate or
     * the result plays at the wrong speed. The device only emits frames when the
     * screen changes, so this is usually below the negotiated rate.
     */
    frameRate: number;
    /** Codec string parsed from the stream's SPS, when one arrived. */
    codecString?: string;
    /** Receive counters. */
    stats: ScreenStreamStats;
  };
  /** The audio track. */
  audio: {
    /** Where the `.m4a` was written. */
    path: string;
    /** Access units written. */
    accessUnitsWritten: number;
    /** Bytes written. */
    bytesWritten: number;
    /**
     * Exact duration in milliseconds, from the access-unit count.
     *
     * Compare against `video.durationMs`: the device ends the audio session at
     * its `RTCPTimeoutInterval` (20 s) because this library sends no RTCP
     * receiver reports, so on longer recordings the audio covers only the first
     * ~20 s while the video runs the whole window.
     */
    durationMs: number;
    /** The captured audio format. */
    format: AacEldFormat;
    /** Receive counters. */
    stats: AudioStreamStats;
  };
  /**
   * A ready-to-run `ffmpeg` invocation that combines the two files, with the
   * measured frame rate already filled in.
   *
   * Muxing is deliberately left outside this library — it needs no device
   * access and callers differ on container, timing and post-processing. This
   * is provided because getting it right is non-obvious: the video stream has
   * no timestamps, so `-fflags +genpts` and an explicit `-r` are both required,
   * and `-c copy` avoids having to decode AAC-ELD at all.
   */
  ffmpegCommand: string;
}

/**
 * Records the device's screen and system audio together, writing **two separate
 * files** — Annex-B HEVC video and an `.m4a` audio track.
 *
 * They are kept separate on purpose: combining them is a pure post-processing
 * step needing no device access, so it belongs outside this library.
 * {@link RecordScreenAndAudioResult.ffmpegCommand} gives the exact command,
 * since it depends on the measured frame rate this function returns.
 *
 * Both streams are negotiated under one shared session id, the way Xcode's
 * mirror pairs them, and are torn down in a single stop — the device has no
 * per-stream stop (see {@link DisplayService.stopAllMediaStreams}).
 *
 * Recording starts at the first video keyframe, since a decoder cannot begin on
 * a delta frame; a little audio may therefore precede the first frame.
 *
 * > **Audio stops after ~20 s; video does not.** This library sends no RTCP
 * > receiver reports, so the device ends the audio session at its
 * > `RTCPTimeoutInterval` of 20 s. Measured on iOS 27.0: a 35 s recording
 * > yielded the full 605 video frames but only 20.04 s of audio. Compare
 * > `audio.durationMs` against `video.durationMs` to detect it; a warning is
 * > logged when they diverge.
 *
 * Requires iOS 27.0+.
 *
 * @param service A connected {@link DisplayService} for the target device.
 * @param options Output paths, duration, and video stream options.
 */
export async function recordScreenAndAudioToFiles(
  service: DisplayService,
  options: RecordScreenAndAudioOptions,
): Promise<RecordScreenAndAudioResult> {
  const {videoPath, audioPath, durationMs = 10000, ...videoOptions} = options;

  // One session id for both streams, matching Xcode's pairing.
  const clientSessionId = videoOptions.clientSessionId ?? XPCUUID.random();

  const videoCapture = await ScreenStreamCapture.start(service, {...videoOptions, clientSessionId});
  let audioCapture: AudioStreamCapture;
  try {
    audioCapture = await AudioStreamCapture.start(service, {clientSessionId});
  } catch (error) {
    await videoCapture.stop().catch((): void => undefined);
    throw error;
  }

  const videoOut = createWriteStream(videoPath);
  const audioUnits: Buffer[] = [];
  let framesWritten = 0;
  let videoBytes = 0;
  let sawKeyFrame = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref?.();
  const startedAt = performance.now();

  const videoTask = (async (): Promise<void> => {
    for await (const unit of videoCapture.accessUnits(controller.signal)) {
      if (!sawKeyFrame) {
        if (!unit.isKeyFrame) {
          continue;
        }
        sawKeyFrame = true;
      }
      const chunk = toAnnexB(unit.nals);
      if (!videoOut.write(chunk)) {
        await once(videoOut, 'drain');
      }
      framesWritten += 1;
      videoBytes += chunk.length;
    }
  })();

  const audioTask = (async (): Promise<void> => {
    for await (const unit of audioCapture.accessUnits(controller.signal)) {
      audioUnits.push(unit.data);
    }
  })();

  let elapsedMs = durationMs;
  try {
    await Promise.all([videoTask, audioTask]);
    elapsedMs = performance.now() - startedAt;
  } finally {
    clearTimeout(timer);
    // One stop tears down both streams; the second call is a no-op.
    await videoCapture.stop().catch((error: unknown) => {
      log.debug(`Failed to stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
    await audioCapture.stop().catch((): void => undefined);
    await new Promise<void>((resolve, reject) => {
      videoOut.end((error?: Error | null): void => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  const m4a = buildM4a(audioUnits);
  await writeFile(audioPath, m4a);

  const audioDurationMs = aacEldDurationMs(audioUnits.length);

  // The frame rate must be measured against the *video's* own capture window,
  // never the audio clock: the device reaps the audio session at its
  // RTCPTimeoutInterval (20 s) while video keeps flowing, so on a longer
  // recording the audio duration is far shorter than the window and would
  // inflate the rate — playing the video back too fast.
  const frameRate = elapsedMs > 0 ? Number(((framesWritten * 1000) / elapsedMs).toFixed(3)) : 0;
  if (audioDurationMs > 0 && audioDurationMs < elapsedMs - 1000) {
    log.warn(
      `Audio stopped early: ${(audioDurationMs / 1000).toFixed(2)}s captured over a ` +
        `${(elapsedMs / 1000).toFixed(2)}s window. The device ends the audio session at its ` +
        'RTCPTimeoutInterval (20s) because no RTCP receiver reports are sent; the video is unaffected.',
    );
  }

  return {
    video: {
      path: videoPath,
      framesWritten,
      bytesWritten: videoBytes,
      durationMs: elapsedMs,
      frameRate,
      codecString: videoCapture.codecString,
      stats: videoCapture.stats,
    },
    audio: {
      path: audioPath,
      accessUnitsWritten: audioUnits.length,
      bytesWritten: m4a.length,
      durationMs: audioDurationMs,
      format: audioCapture.format,
      stats: audioCapture.stats,
    },
    ffmpegCommand: buildFfmpegCommand({videoPath, audioPath, frameRate}),
  };
}

/**
 * Builds the `ffmpeg` command that combines the two tracks.
 *
 * `-fflags +genpts` with an explicit `-r` is required because the Annex-B video
 * carries no timestamps — without them a muxer produces an empty audio track.
 */
function buildFfmpegCommand(options: {videoPath: string; audioPath: string; frameRate: number}): string {
  const {videoPath, audioPath, frameRate} = options;
  const output = videoPath.replace(/\.[^.]+$/, '') + '.mp4';
  return (
    `ffmpeg -y -fflags +genpts -r ${frameRate} -i '${videoPath}' -i '${audioPath}' ` +
    `-map 0:v:0 -map 1:a:0 -c copy -tag:v hvc1 '${output}'`
  );
}
