import {getLogger} from '../../../../lib/logger.js';
import type {DisplayService, MediaStreamAnswer, StartAudioStreamOptions} from '../index.js';
import {PacketLossReporter} from '../transport/packet-loss-reporter.js';
import {RtcpKeepalive, rtcpIdentityFromStreamConfig} from '../transport/rtcp.js';
import {UdpMediaReceiver, isNextSequence, parseRtpPacket} from '../transport/rtp.js';
import {AAC_ELD_FORMAT, type AacEldFormat, aacEldDurationMs} from './aac-eld.js';
import {M4aFileWriter} from './m4a-writer.js';

const log = getLogger('AudioStreamCapture');

/** One AAC-ELD access unit — 480 frames, i.e. 10 ms of 48 kHz stereo audio. */
export interface AudioAccessUnit {
  /** The encoded AAC-ELD bytes, ready for a decoder or an MP4 sample. */
  data: Buffer;
  /** RTP media-clock timestamp. */
  timestamp: number;
  /** RTP sequence number. */
  sequence: number;
  /** Monotonic host time when it arrived, from `performance.now()`. */
  receivedAt: number;
}

/** Counters for an audio capture. */
export interface AudioStreamStats {
  /** RTP packets accepted (RTCP and malformed datagrams excluded). */
  packetsReceived: number;
  /** Packets missing according to RTP sequence numbers. */
  packetsLost: number;
  /** Access units delivered. */
  accessUnitsEmitted: number;
}

/** Options for {@link AudioStreamCapture.start}. */
export interface AudioStreamCaptureOptions extends StartAudioStreamOptions {
  /** Local UDP port to receive on; `0` (default) lets the OS choose. */
  receiverPort?: number;
}

/**
 * Receives the device's system-audio stream.
 *
 * The audio path is much simpler than video: **one RTP payload carries exactly
 * one AAC-ELD access unit** — no aggregation, no fragmentation — so this just
 * unwraps RTP and hands the encoded units over.
 *
 * Nothing here decodes the audio. Decoding AAC-ELD needs a decoder told about
 * its 480-sample frames (see `aac-eld.ts`), so this exposes the encoded units
 * plus {@link format} — including the `AudioSpecificConfig` a decoder needs —
 * and {@link recordAudioToFile} wraps them in an `.m4a` that other tools can
 * read directly.
 *
 * A lost packet drops one 10 ms unit; unlike video there is no reference chain,
 * so the stream recovers on the next packet and nothing further is discarded.
 *
 * Requires iOS 27.0+ — see {@link DisplayService} for the version gate.
 *
 * @example
 * ```ts
 * const capture = await AudioStreamCapture.start(display);
 * try {
 *   for await (const au of capture.accessUnits()) {
 *     // au.data is one AAC-ELD access unit
 *   }
 * } finally {
 *   await capture.stop();
 * }
 * ```
 */
export class AudioStreamCapture {
  private readonly service: DisplayService;
  private readonly receiver: UdpMediaReceiver;
  private readonly abortController = new AbortController();

  private readonly lossReporter = new PacketLossReporter(log, 'audio');

  private statsInternal: AudioStreamStats = {packetsReceived: 0, packetsLost: 0, accessUnitsEmitted: 0};
  private lastSequence: number | undefined;
  /** Holds the device's audio session open past its 20 s RTCP timeout. */
  private keepalive: RtcpKeepalive | undefined;
  /** In-flight teardown, so concurrent stop() callers await the same completion. */
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
   * Binds the receiver and negotiates the audio stream.
   *
   * The socket is bound before negotiating because the device starts sending as
   * soon as it answers.
   *
   * @param service A connected {@link DisplayService} for the target device.
   * @param options Receiver port plus everything `startAudioStream` accepts.
   */
  static async start(service: DisplayService, options: AudioStreamCaptureOptions = {}): Promise<AudioStreamCapture> {
    const {receiverPort, ...streamOptions} = options;
    const receiver = await UdpMediaReceiver.bind({port: receiverPort});
    try {
      const [receiverIp, senderIp] = await Promise.all([service.getTunnelLocalAddress(), service.getDeviceAddress()]);
      log.debug(`Audio receiver bound on [${receiverIp}]:${receiver.port}, device at ${senderIp}`);
      const answer = await service.startAudioStream({receiverIp, receiverPort: receiver.port, senderIp}, streamOptions);
      const capture = new AudioStreamCapture(service, receiver, answer);

      // Without receiver reports the device stops sending audio after ~20 s.
      const identity = rtcpIdentityFromStreamConfig(answer.streamConfig, senderIp);
      if (identity) {
        capture.keepalive = RtcpKeepalive.start(receiver, identity, {label: 'audio'});
      } else {
        log.warn('Audio streamConfig lacked SSRCs or a source port; the session will end after ~20s');
      }
      return capture;
    } catch (error) {
      receiver.close();
      throw error;
    }
  }

  /** The audio format, including the `AudioSpecificConfig` for a decoder. */
  get format(): AacEldFormat {
    return AAC_ELD_FORMAT;
  }

  /** A snapshot of the receive counters. */
  get stats(): AudioStreamStats {
    return {...this.statsInternal};
  }

  /**
   * Yields access units until {@link stop} is called or `signal` aborts.
   *
   * @param signal Optional caller-owned abort signal, in addition to `stop()`.
   */
  async *accessUnits(signal?: AbortSignal): AsyncGenerator<AudioAccessUnit, void, unknown> {
    const onExternalAbort = (): void => this.abortController.abort();
    signal?.addEventListener('abort', onExternalAbort, {once: true});
    try {
      for await (const datagram of this.receiver.packets(this.abortController.signal)) {
        const packet = parseRtpPacket(datagram);
        if (!packet || packet.payload.length === 0) {
          continue; // RTCP, malformed, or an empty keep-alive.
        }
        this.statsInternal.packetsReceived += 1;

        if (this.lastSequence !== undefined && !isNextSequence(this.lastSequence, packet.sequence)) {
          const missing = (packet.sequence - this.lastSequence - 1) & 0xffff;
          this.statsInternal.packetsLost += missing;
          this.lossReporter.record(missing, packet.sequence);
        }
        this.lastSequence = packet.sequence;
        this.keepalive?.observeSequence(packet.sequence);

        this.statsInternal.accessUnitsEmitted += 1;
        yield {
          data: packet.payload,
          timestamp: packet.timestamp,
          sequence: packet.sequence,
          receivedAt: performance.now(),
        };
      }
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Stops the stream on the device and closes the receiver. Safe to call more
   * than once.
   *
   * The device only supports stopping *all* media streams at once — see
   * {@link DisplayService.stopAllMediaStreams} — so this also tears down a
   * paired video stream if one is running.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.tearDown();
    return this.stopPromise;
  }

  private async tearDown(): Promise<void> {
    this.keepalive?.stop();
    this.abortController.abort();
    this.receiver.close();
    this.lossReporter.flush();
    await this.service.stopAllMediaStreams();
  }
}

/** Options for {@link recordAudioToFile}. */
export interface RecordAudioOptions extends AudioStreamCaptureOptions {
  /** How long to record, in milliseconds. Defaults to 5000. */
  durationMs?: number;
}

/** What {@link recordAudioToFile} produced. */
export interface RecordAudioResult {
  /** Where the `.m4a` was written. */
  outputPath: string;
  /** Access units written. */
  accessUnitsWritten: number;
  /** Bytes written. */
  bytesWritten: number;
  /** Exact audio duration in milliseconds, derived from the access-unit count. */
  durationMs: number;
  /** The captured audio format. */
  format: AacEldFormat;
  /** Receive counters at the end of the recording. */
  stats: AudioStreamStats;
}

/**
 * Records the device's system audio to an `.m4a`.
 *
 * The AAC-ELD access units are wrapped in an MP4 whose `esds` declares the
 * format, which is what makes the result usable outside this library: QuickTime
 * plays it as-is, and `ffmpeg -c copy` can mux it against a screen recording
 * without needing to decode AAC-ELD.
 *
 * Access units are streamed to the file as they arrive rather than collected
 * first, so memory does not grow with the recording's length — see
 * {@link M4aFileWriter}.
 *
 * Requires iOS 27.0+.
 *
 * @param service A connected {@link DisplayService} for the target device.
 * @param outputPath Destination `.m4a` path.
 * @param options Duration and stream options.
 */
export async function recordAudioToFile(
  service: DisplayService,
  outputPath: string,
  options: RecordAudioOptions = {},
): Promise<RecordAudioResult> {
  const {durationMs = 5000, ...captureOptions} = options;

  const capture = await AudioStreamCapture.start(service, captureOptions);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref?.();

  const writer = await M4aFileWriter.create(outputPath);
  let written;
  try {
    for await (const unit of capture.accessUnits(controller.signal)) {
      await writer.write(unit.data);
    }
  } finally {
    clearTimeout(timer);
    await capture.stop().catch((error: unknown) => {
      log.debug(`Failed to stop the audio stream cleanly: ${error instanceof Error ? error.message : String(error)}`);
    });
    written = await writer.close();
  }

  return {
    outputPath,
    accessUnitsWritten: written.sampleCount,
    bytesWritten: written.bytesWritten,
    durationMs: aacEldDurationMs(written.sampleCount),
    format: capture.format,
    stats: capture.stats,
  };
}
