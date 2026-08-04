import {once} from 'node:events';
import {createWriteStream} from 'node:fs';

import {getLogger} from '../../../lib/logger.js';
import {
  AccessUnitAssembler,
  type HevcParameterSets,
  type ScreenStreamStats,
  type VideoAccessUnit,
} from './access-unit-assembler.js';
import {toAnnexB} from './hevc.js';
import type {DisplayService, MediaStreamAnswer, StartVideoStreamOptions} from './index.js';
import {RtcpKeepalive, rtcpIdentityFromStreamConfig} from './rtcp.js';
import {UdpMediaReceiver, parseRtpPacket} from './rtp.js';

export type {HevcParameterSets, ScreenStreamStats, VideoAccessUnit};

const log = getLogger('ScreenStreamCapture');

/** Options for {@link ScreenStreamCapture.start}. */
export interface ScreenStreamCaptureOptions extends StartVideoStreamOptions {
  /** Local UDP port to receive on; `0` (default) lets the OS choose. */
  receiverPort?: number;
}

/**
 * Receives and reassembles the device's HEVC screen stream.
 *
 * Binds the UDP receiver, negotiates the stream through {@link DisplayService},
 * then turns the inbound RTP into access units:
 *
 * ```
 * device → RTP/UDP → RFC 7798 depacketize → NAL units
 *        → access units (split on the RTP marker bit)
 * ```
 *
 * Access units whose packets were incomplete are dropped rather than passed on:
 * a decoder fed a partial picture renders visible corruption that then
 * propagates through every delta frame that references it.
 *
 * Requires iOS 27.0+ — see {@link DisplayService} for the version gate.
 *
 * @example
 * ```ts
 * const capture = await ScreenStreamCapture.start(display, {displayId: 1});
 * try {
 *   for await (const au of capture.accessUnits()) {
 *     if (au.isKeyFrame) {
 *       // ...
 *     }
 *   }
 * } finally {
 *   await capture.stop();
 * }
 * ```
 */
export class ScreenStreamCapture {
  private readonly service: DisplayService;
  private readonly receiver: UdpMediaReceiver;
  private readonly assembler = new AccessUnitAssembler();
  private readonly abortController = new AbortController();
  /** Holds the device's video session open past its 20 s RTCP timeout. */
  private keepalive: RtcpKeepalive | undefined;

  /**
   * The in-flight teardown, cached so concurrent {@link stop} callers all await
   * the *same* completion rather than the later ones returning early while the
   * first is still tearing down.
   */
  private stopPromise: Promise<void> | undefined;

  private constructor(
    service: DisplayService,
    receiver: UdpMediaReceiver,
    readonly answer: MediaStreamAnswer,
  ) {
    this.service = service;
    this.receiver = receiver;
  }

  /**
   * Binds the receiver and negotiates the stream.
   *
   * The socket is bound before negotiating because the device starts sending
   * as soon as it answers.
   *
   * @param service A connected {@link DisplayService} for the target device.
   * @param options Receiver port plus everything `startVideoStream` accepts.
   */
  static async start(service: DisplayService, options: ScreenStreamCaptureOptions = {}): Promise<ScreenStreamCapture> {
    const {receiverPort, ...streamOptions} = options;
    const receiver = await UdpMediaReceiver.bind({port: receiverPort});
    try {
      const [receiverIp, senderIp] = await Promise.all([service.getTunnelLocalAddress(), service.getDeviceAddress()]);
      log.debug(`Media receiver bound on [${receiverIp}]:${receiver.port}, device at ${senderIp}`);
      const answer = await service.startVideoStream({receiverIp, receiverPort: receiver.port, senderIp}, streamOptions);
      const capture = new ScreenStreamCapture(service, receiver, answer);

      // Without receiver reports the device stops sending video after ~20 s.
      const identity = rtcpIdentityFromStreamConfig(answer.streamConfig, senderIp);
      if (identity) {
        capture.keepalive = RtcpKeepalive.start(receiver, identity, {label: 'video'});
      } else {
        log.warn('Video streamConfig lacked SSRCs or a source port; the session will end after ~20s');
      }
      return capture;
    } catch (error) {
      receiver.close();
      throw error;
    }
  }

  /** Parameter sets seen so far; complete once VPS, SPS and PPS have arrived. */
  get parameterSets(): HevcParameterSets | undefined {
    return this.assembler.parameterSets;
  }

  /**
   * The WebCodecs / MIME codec string (e.g. `hev1.1.6.L120.90`), available once
   * the SPS has arrived.
   */
  get codecString(): string | undefined {
    return this.assembler.codecString;
  }

  /**
   * The hvcC decoder configuration record, available once all three parameter
   * sets have arrived. Pair it with `toLengthPrefixed` framing.
   */
  get decoderConfigurationRecord(): Buffer | undefined {
    return this.assembler.decoderConfigurationRecord;
  }

  /** A snapshot of the receive counters. */
  get stats(): ScreenStreamStats {
    return this.assembler.stats;
  }

  /**
   * Yields access units until {@link stop} is called or `signal` aborts.
   *
   * @param signal Optional caller-owned abort signal, in addition to `stop()`.
   */
  async *accessUnits(signal?: AbortSignal): AsyncGenerator<VideoAccessUnit, void, unknown> {
    const onExternalAbort = (): void => this.abortController.abort();
    signal?.addEventListener('abort', onExternalAbort, {once: true});
    try {
      for await (const datagram of this.receiver.packets(this.abortController.signal)) {
        const unit = this.consume(datagram);
        if (unit) {
          yield unit;
        }
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Stops the stream on the device and closes the receiver. Safe to call more
   * than once.
   *
   * Note that the device only supports stopping *all* media streams at once —
   * see {@link DisplayService.stopAllMediaStreams} — so this also tears down
   * any other stream (for example a paired audio stream) running on the device.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.tearDown();
    return this.stopPromise;
  }

  private async tearDown(): Promise<void> {
    this.keepalive?.stop();
    this.abortController.abort();
    this.receiver.close();
    await this.service.stopAllMediaStreams();
  }

  /**
   * Feeds one datagram through the pipeline, returning a completed access unit
   * when this packet carried the marker bit.
   */
  private consume(datagram: Buffer): VideoAccessUnit | undefined {
    const packet = parseRtpPacket(datagram);
    if (!packet) {
      return undefined; // RTCP or malformed; not our concern here.
    }
    this.keepalive?.observeSequence(packet.sequence);
    return this.assembler.push(packet);
  }
}

/** Options for {@link recordScreenToFile}. */
export interface RecordScreenOptions extends ScreenStreamCaptureOptions {
  /** How long to record, in milliseconds. Defaults to 5000. */
  durationMs?: number;
  /**
   * Stop after this many access units, if reached before `durationMs`.
   * Unlimited by default.
   */
  maxFrames?: number;
}

/** What {@link recordScreenToFile} produced. */
export interface RecordScreenResult {
  /** Where the Annex-B elementary stream was written. */
  outputPath: string;
  /** Access units written to the file. */
  framesWritten: number;
  /** Bytes written. */
  bytesWritten: number;
  /** Codec string parsed from the stream's SPS, when one arrived. */
  codecString?: string;
  /** Receive counters at the end of the recording. */
  stats: ScreenStreamStats;
}

/**
 * Records the device's screen to an Annex-B HEVC elementary stream — the
 * `.h265` layout that ffmpeg and VLC can play or remux directly:
 *
 * ```sh
 * ffmpeg -i screen.h265 -c copy screen.mp4
 * ```
 *
 * Recording starts at the first keyframe, since a decoder cannot begin on a
 * delta frame. Requires iOS 27.0+.
 *
 * @param service A connected {@link DisplayService} for the target device.
 * @param outputPath Destination file path.
 * @param options Duration, frame cap and stream options.
 */
export async function recordScreenToFile(
  service: DisplayService,
  outputPath: string,
  options: RecordScreenOptions = {},
): Promise<RecordScreenResult> {
  const {durationMs = 5000, maxFrames = Number.POSITIVE_INFINITY, ...captureOptions} = options;

  const capture = await ScreenStreamCapture.start(service, captureOptions);
  const output = createWriteStream(outputPath);
  let framesWritten = 0;
  let bytesWritten = 0;
  let sawKeyFrame = false;

  const deadline = performance.now() + durationMs;
  const timer = setTimeout((): void => {
    capture.stop().catch((): void => undefined);
  }, durationMs);
  // The recording is bounded by wall time, so a long-lived timer must not hold
  // the event loop open on its own.
  timer.unref?.();

  try {
    for await (const unit of capture.accessUnits()) {
      if (!sawKeyFrame) {
        if (!unit.isKeyFrame) {
          continue; // Nothing decodable yet.
        }
        sawKeyFrame = true;
      }

      const chunk = toAnnexB(unit.nals);
      if (!output.write(chunk)) {
        await once(output, 'drain');
      }
      framesWritten += 1;
      bytesWritten += chunk.length;

      if (framesWritten >= maxFrames || performance.now() >= deadline) {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    await capture.stop().catch((error: unknown) => {
      log.debug(`Failed to stop the media stream cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null): void => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    outputPath,
    framesWritten,
    bytesWritten,
    codecString: capture.codecString,
    stats: capture.stats,
  };
}
