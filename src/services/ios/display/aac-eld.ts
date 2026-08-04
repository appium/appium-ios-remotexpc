/**
 * AAC-ELD constants for the DisplayService system-audio stream.
 *
 * The device streams Enhanced Low Delay AAC — not plain AAC-LC — and that
 * distinction matters for anything downstream:
 *
 * - ELD uses **480-sample** frames, where AAC-LC uses 1024. Decoders that
 *   assume the default frame size interpret each access unit as a longer block
 *   and emit clipped noise, which is why the access units must be carried in a
 *   container that states the format rather than handed over raw.
 * - ELD cannot be expressed in ADTS: the ADTS header's 2-bit profile field only
 *   covers Main/LC/SSR/LTP, so there is no valid raw framing for it. An MP4
 *   `esds` carrying the AudioSpecificConfig is the portable option — see
 *   {@link buildM4a}.
 */

/**
 * The `AudioSpecificConfig` the device advertises during the Mirror handshake.
 *
 * Decodes as audioObjectType 39 (ER AAC ELD), samplingFrequencyIndex 3
 * (48 kHz), channelConfiguration 2 (stereo) — **and `frameLengthFlag = 0`,
 * which claims 512-sample frames.**
 *
 * That claim is wrong. The stream really carries 480-sample frames, which is
 * provable from the data: a 20.00 s capture yielded 1996 access units, and
 * 1996 × 512 / 48000 = 21.29 s of audio, more than the window it arrived in,
 * whereas 480 gives exactly 19.96 s.
 *
 * A decoder that believes this cookie mis-slices every access unit — ffmpeg
 * reports "Number of bands (36) exceeds limit (34)" and AudioToolbox refuses
 * the stream outright. Kept only for reference and for callers reproducing the
 * device's exact handshake bytes; use {@link AAC_ELD_ASC_48K_STEREO_480} to
 * describe the stream truthfully.
 */
export const AAC_ELD_ASC_DEVICE_ADVERTISED = Buffer.from([0xf8, 0xe6, 0x40, 0x00]);

/**
 * `AudioSpecificConfig` describing the stream as it actually is: AAC-ELD,
 * 48 kHz stereo, **480-sample frames** (`frameLengthFlag = 1`).
 *
 * Identical to {@link AAC_ELD_ASC_DEVICE_ADVERTISED} except for that one bit,
 * and that bit is what makes the audio decodable by standard tooling. Verified
 * on captured device audio: with this config both ffmpeg's native AAC decoder
 * and macOS AudioToolbox decode cleanly to 48 kHz stereo PCM, agreeing with
 * each other to within 1 LSB (identical RMS); with the device's own config both
 * fail.
 */
export const AAC_ELD_ASC_48K_STEREO_480 = Buffer.from([0xf8, 0xe6, 0x50, 0x00]);

/** Sample rate the device's audio stream uses. */
export const AAC_ELD_SAMPLE_RATE = 48000;

/** Channel count the device's audio stream uses. */
export const AAC_ELD_CHANNELS = 2;

/**
 * Frames (samples per channel) in one AAC-ELD access unit. At 48 kHz this makes
 * each access unit exactly 10 ms of audio.
 */
export const AAC_ELD_FRAMES_PER_PACKET = 480;

/** RTP payload type the device advertises for the audio stream. */
export const AAC_ELD_RTP_PAYLOAD_TYPE = 101;

/** Describes the audio format carried by a capture. */
export interface AacEldFormat {
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Channel count. */
  channels: number;
  /** Frames per access unit. */
  framesPerPacket: number;
  /**
   * The `AudioSpecificConfig` a decoder needs as its magic cookie. Defaults to
   * {@link AAC_ELD_ASC_48K_STEREO_480}, not the device's own (broken) cookie.
   */
  audioSpecificConfig: Buffer;
}

/** The format the device streams. */
export const AAC_ELD_FORMAT: AacEldFormat = {
  sampleRate: AAC_ELD_SAMPLE_RATE,
  channels: AAC_ELD_CHANNELS,
  framesPerPacket: AAC_ELD_FRAMES_PER_PACKET,
  audioSpecificConfig: AAC_ELD_ASC_48K_STEREO_480,
};

/** Duration of `accessUnitCount` access units, in milliseconds. */
export function aacEldDurationMs(accessUnitCount: number): number {
  return (accessUnitCount * AAC_ELD_FRAMES_PER_PACKET * 1000) / AAC_ELD_SAMPLE_RATE;
}
