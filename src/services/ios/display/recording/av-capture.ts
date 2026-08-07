import {once} from 'node:events';
import {createWriteStream} from 'node:fs';

import {getLogger} from '../../../../lib/logger.js';
import {XPCUUID} from '../../../../lib/remote-xpc/xpc-uuid.js';
import {type AacEldFormat, aacEldDurationMs} from '../audio/aac-eld.js';
import {AudioStreamCapture, type AudioStreamStats} from '../audio/audio-stream-capture.js';
import {M4aFileWriter} from '../audio/m4a-writer.js';
import {type DisplayService, type StartVideoStreamOptions} from '../index.js';
import {toAnnexB} from '../video/hevc.js';
import {ScreenStreamCapture, type ScreenStreamStats} from '../video/screen-stream-capture.js';
import {type MuxCommand, ffmpegMuxCommandBuilder} from './mux-command.js';

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
     * Should track `video.durationMs` closely; a large shortfall means the
     * device ended the audio session early.
     */
    durationMs: number;
    /** The captured audio format. */
    format: AacEldFormat;
    /** Receive counters. */
    stats: AudioStreamStats;
  };
  /**
   * A ready-to-run `ffmpeg` invocation that combines the two files, as a binary
   * plus an argument vector, with the measured frame rate already filled in.
   *
   * Pass it straight to `spawn`. To show it to a human, render it with
   * `formatMuxCommand`. For a different backend, build the command from the
   * returned tracks and `video.frameRate` with another `MuxCommandBuilder`.
   */
  muxCommand: MuxCommand;
}

/**
 * Records the device's screen and system audio together, writing **two separate
 * files** — Annex-B HEVC video and an `.m4a` audio track.
 *
 * They are kept separate on purpose: combining them is a pure post-processing
 * step needing no device access, so it belongs outside this library.
 * {@link RecordScreenAndAudioResult.muxCommand} gives the exact command to run,
 * since it depends on the measured frame rate this function returns.
 *
 * Both tracks are streamed to disk as they arrive, so memory does not grow with
 * the recording's length.
 *
 * Both streams are negotiated under one shared session id, the way Xcode's
 * mirror pairs them, and are torn down in a single stop — the device has no
 * per-stream stop (see {@link DisplayService.stopAllMediaStreams}).
 *
 * Recording starts at the first video keyframe, since a decoder cannot begin on
 * a delta frame; a little audio may therefore precede the first frame.
 *
 * Both captures send periodic RTCP receiver reports, so recordings are not
 * bounded by the device's 20 s `RTCPTimeoutInterval`. Verified on iOS 27.0: a
 * 60 s recording captured 2827 video frames and 59.97 s of audio with no loss.
 * A warning is still logged if the two durations diverge, which would mean the
 * device dropped a session for some other reason.
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
  const audioOut = await M4aFileWriter.create(audioPath);
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
      await audioOut.write(unit.data);
    }
  })();

  let elapsedMs = durationMs;
  let audioWritten;
  try {
    await Promise.all([videoTask, audioTask]);
    elapsedMs = performance.now() - startedAt;
  } finally {
    clearTimeout(timer);
    // Both loops must be finished before the writers close. `Promise.all`
    // rejects as soon as either task does, leaving the other still consuming
    // its stream — and a write landing after close() would reject on a promise
    // nobody is waiting on. Aborting and settling both first rules that out.
    controller.abort();
    await Promise.allSettled([videoTask, audioTask]);
    // One stop tears down both streams; the second call is a no-op.
    await videoCapture.stop().catch((error: unknown) => {
      log.debug(`Failed to stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
    await audioCapture.stop().catch((): void => undefined);
    audioWritten = await audioOut.close();
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

  const audioDurationMs = aacEldDurationMs(audioWritten.sampleCount);

  // Measure against the video's own capture window, never the audio clock: if
  // the device ever ends the audio session early the audio duration would be
  // shorter than the window and would skew the rate, playing the video back at
  // the wrong speed.
  const frameRate = elapsedMs > 0 ? Number(((framesWritten * 1000) / elapsedMs).toFixed(3)) : 0;
  if (audioDurationMs > 0 && audioDurationMs < elapsedMs - 1000) {
    log.warn(
      `Audio stopped early: ${(audioDurationMs / 1000).toFixed(2)}s captured over a ` +
        `${(elapsedMs / 1000).toFixed(2)}s window. The device ends the audio session at its ` +
        'RTCPTimeoutInterval (20s) when receiver reports stop arriving.',
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
      accessUnitsWritten: audioWritten.sampleCount,
      bytesWritten: audioWritten.bytesWritten,
      durationMs: audioDurationMs,
      format: audioCapture.format,
      stats: audioCapture.stats,
    },
    muxCommand: ffmpegMuxCommandBuilder.build({videoPath, audioPath, frameRate}),
  };
}
