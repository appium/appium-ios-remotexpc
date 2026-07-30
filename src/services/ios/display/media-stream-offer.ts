/**
 * Builders for the `negotiatorOffer` that
 * `com.apple.coredevice.action.mediastreamstart` requires.
 *
 * The offer is a binary plist with four keys:
 *
 * ```
 * {
 *   avcMediaStreamOptionRemoteEndpointInfo: <protobuf describing the host>,
 *   avcMediaStreamNegotiatorMode:           <5 = video, 6 = audio>,
 *   avcMediaStreamNegotiatorMediaBlob:      <zlib-compressed protobuf holding
 *                                            codec params + feature strings>,
 *   avcMediaStreamOptionCallID:             <UUID string>,
 * }
 * ```
 *
 * The `mediaBlob` protobuf schema was reverse-engineered from
 * `-[AVCMediaStreamNegotiator createOffer]`:
 *
 * ```
 * MediaBlob (top level) {
 *   1:  int = 1                 // constant
 *   2:  int = 1                 // constant
 *   5:  VideoSettings (video) | 3: AudioSettings (audio)
 *   6:  string                  // decoder identity, e.g. "Viceroy 1.7.0"
 *   8:  int = 0
 *   9:  BitrateTier[]           // repeated tier descriptors
 *   13: int                     // host-clock timestamp (not validated by the device)
 *   14: int = 2
 *   16: int = 0
 *   18: int = 1
 * }
 *
 * VideoSettings {
 *   1:  int   // SSRC / session id, written as a 5-byte padded varint
 *   2:  int   // allowRTCPFB
 *   3:  CodecBank[]             // one HEVC bank, one AVC bank
 *   7:  int   // ltrpEnabled
 *   8:  int = 63                // pixelFormats
 *   10: int   // fecEnabled (omitted when off)
 *   12: int = 1                 // blackFrameOnClearScreenEnabled
 * }
 *
 * AudioSettings {
 *   1: int    // session id (5-byte padded varint)
 *   2: int = 0
 *   3: int = 0
 *   4: int = 24191              // constant from Apple captures
 *   5: int = 0
 *   6: int = 0
 * }
 *
 * CodecBank {
 *   1: int                      // payload type (HEVC = 123, AVC = 100)
 *   2: ResEntry[]               // 4 entries for HEVC, 2 for AVC
 *   3: string                   // feature list ("FLS;...;")
 *   4: int                      // HEVC = 1, AVC = 14
 * }
 *
 * ResEntry { 1: int = 1, 2: int (pair index 1|2), 3: int = 50115, 4: int = 0 }
 *
 * BitrateTier { 1: int (kind), 2: int (bps), 3: int? (buffer cap) }
 * ```
 *
 * `test/unit/display/media-stream-offer.spec.ts` locks the builders to Apple's
 * captured Xcode offers byte-for-byte.
 */
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';

import {createBinaryPlist} from '../../../lib/plist/binary-plist-creator.js';

/** Decoder identity embedded in the mediaBlob; the daemon matches on it. */
export const DEFAULT_DECODER_NAME = 'Viceroy 1.7.0';

/** `avcMediaStreamNegotiatorMode` for a video offer. */
export const NEGOTIATOR_MODE_VIDEO = 5;
/** `avcMediaStreamNegotiatorMode` for an audio offer. */
export const NEGOTIATOR_MODE_AUDIO = 6;

/** RTP payload type advertised for the HEVC codec bank. */
export const HEVC_PAYLOAD_TYPE = 123;
/** RTP payload type advertised for the AVC codec bank. */
export const AVC_PAYLOAD_TYPE = 100;

/**
 * Host identity reported to the device. Defaults match what Xcode sends; the
 * device appears to pick encoder parameters from it, and Apple's own identity
 * is the best-tested path.
 */
export interface HostEndpointIdentity {
  /** Hardware model, e.g. `'Mac15,9'`. */
  model?: string;
  /** Host OS version, e.g. `'2205.3.1'`. */
  osVersion?: string;
  /** Host OS build, e.g. `'25F80'`. */
  build?: string;
}

const DEFAULT_HOST_IDENTITY: Required<HostEndpointIdentity> = {
  model: 'Mac15,9',
  osVersion: '2205.3.1',
  build: '25F80',
};

/**
 * Bitrate-tier descriptor (`f9` in the top-level message). `kind` 0 is a
 * primary tier carrying a bps cap plus buffer cap; other values are
 * codec-specific markers.
 */
type BitrateTier = readonly [kind: number, bps: number, bufferCap: number | null];

// Apple's canonical tier table. Video and audio were captured in different
// orders; both are kept verbatim so the byte-equivalence check holds.
const DEFAULT_VIDEO_BITRATE_TIERS: readonly BitrateTier[] = [
  [4074, 0, 16384],
  [0, 75_000_000, 524288],
  [0, 40_000_000, 12288],
  [16, 4100, null],
  [0, 20_000_000, 98304],
  [4, 6500, null],
  [0, 6_000_000, 131072],
  [0, 100_000_000, 1048576],
  [0, 60_000_000, 262144],
  [1, 299, null],
];

const DEFAULT_AUDIO_BITRATE_TIERS: readonly BitrateTier[] = [
  [4074, 0, 16384],
  [1, 299, null],
  [0, 60_000_000, 262144],
  [4, 6500, null],
  [0, 20_000_000, 98304],
  [0, 100_000_000, 1048576],
  [0, 40_000_000, 12288],
  [0, 6_000_000, 131072],
  [16, 4100, null],
  [0, 75_000_000, 524288],
];

// `FLS;` is the AVConference framing marker; the rest is a semicolon list of
// capability flags. These are the sets Apple's own capture declared.
const DEFAULT_HEVC_FEATURES = 'FLS;SW:1;';
const DEFAULT_AVC_FEATURES = 'FLS;VRAE:0;SW:1;';

/** Fixed AVConference codec-capability id baked into every ResEntry. */
const RES_ENTRY_CODEC_CAP_ID = 50115;

// Timestamps from the captured templates. Kept as defaults so the builders stay
// byte-identical to Apple's offers; the daemon shows no sign of validating them.
// Both exceed Number.MAX_SAFE_INTEGER, hence bigint.
const CAPTURED_VIDEO_TIMESTAMP = 17137042128614416384n;
const CAPTURED_AUDIO_TIMESTAMP = 17137179377605574656n;

// ---------------------------------------------------------------------------
// protobuf primitives
// ---------------------------------------------------------------------------

function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  if (remaining < 0n) {
    throw new RangeError(`varint cannot encode a negative value: ${value}`);
  }
  const out: number[] = [];
  for (;;) {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) {
      out.push(byte | 0x80);
    } else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}

/**
 * Encodes `value` as a varint padded out to exactly `width` bytes.
 *
 * Protobuf ignores redundant continuation bytes (low 7 bits zero, continuation
 * flag set), and Apple's captured offers use that to give the session id a
 * fixed-width 5-byte slot the encoder can rewrite in place.
 */
function varintPadded(value: number | bigint, width: number): Buffer {
  let raw = [...varint(value)];
  if (raw.length > width) {
    // Wrapping is what the fixed-width slot does anyway; make it explicit.
    raw = [...varint(BigInt(value) & ((1n << BigInt(7 * width)) - 1n))];
  }
  while (raw.length < width) {
    raw[raw.length - 1] |= 0x80;
    raw.push(0x00);
  }
  return Buffer.from(raw);
}

function tag(field: number, wireType: number): Buffer {
  return varint((field << 3) | wireType);
}

function fieldVarint(field: number, value: number | bigint): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function fieldBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(value.length), value]);
}

function fieldString(field: number, value: string): Buffer {
  return fieldBytes(field, Buffer.from(value, 'utf8'));
}

// ---------------------------------------------------------------------------
// mediaBlob pieces
// ---------------------------------------------------------------------------

function resEntry(pairIndex: number): Buffer {
  return Buffer.concat([
    fieldVarint(1, 1),
    fieldVarint(2, pairIndex),
    fieldVarint(3, RES_ENTRY_CODEC_CAP_ID),
    fieldVarint(4, 0),
  ]);
}

/**
 * A CodecBank body. `resPairCount` is 4 for HEVC and 2 for AVC; the bank
 * carries alternating pair indices 1, 2.
 */
function codecBank(payloadType: number, features: string, trailer: number, resPairCount: number): Buffer {
  const parts: Buffer[] = [fieldVarint(1, payloadType)];
  for (let i = 0; i < resPairCount; i++) {
    parts.push(fieldBytes(2, resEntry(1 + (i % 2))));
  }
  parts.push(fieldString(3, features), fieldVarint(4, trailer));
  return Buffer.concat(parts);
}

function buildTopLevel(options: {
  settingsField: number;
  settingsBody: Buffer;
  decoderName: string;
  timestamp: bigint;
  bitrateTiers: readonly BitrateTier[];
}): Buffer {
  const tiers = options.bitrateTiers.map(([kind, bps, bufferCap]) => {
    const body = Buffer.concat([
      fieldVarint(1, kind),
      fieldVarint(2, bps),
      ...(bufferCap === null ? [] : [fieldVarint(3, bufferCap)]),
    ]);
    return fieldBytes(9, body);
  });

  return Buffer.concat([
    fieldVarint(1, 1),
    fieldVarint(2, 1),
    fieldBytes(options.settingsField, options.settingsBody),
    fieldString(6, options.decoderName),
    fieldVarint(8, 0),
    ...tiers,
    fieldVarint(13, options.timestamp),
    fieldVarint(14, 2),
    fieldVarint(16, 0),
    fieldVarint(18, 1),
  ]);
}

/** Tunables for the video mediaBlob. Defaults are the probed-good values. */
export interface VideoMediaBlobOptions {
  /**
   * Protobuf-level `allowRTCPFB` flag. No observable effect on the device's
   * `streamConfig` answer; exposed in case it changes encoder behaviour.
   */
  allowRtcpFb?: boolean;
  /**
   * Protobuf-level `ltrpEnabled` (long-term reference pictures). The device
   * honours the request. Off by default: LTRP-off removes mid-stream tearing
   * under UDP loss. Apple's captured offer used `true`.
   */
  ltrpEnabled?: boolean;
  /** Forward error correction. Accepted by the device but not echoed back. */
  fecEnabled?: boolean;
  /** Encoder tiles per frame. Accepted but ignored when AVC is negotiated. */
  tilesPerFrame?: number;
  /** HEVC capability string declared inside the bank. */
  hevcFeatures?: string;
  /** AVC capability string declared inside the bank. */
  avcFeatures?: string;
  /** Decoder identity string. */
  decoderName?: string;
  /** Host-clock timestamp field. */
  timestamp?: bigint;
}

/**
 * Builds the video mediaBlob protobuf.
 *
 * Field numbers were recovered from the `__objc_methname` table of
 * `VCMediaNegotiationBlobVideoSettings`: f1 = SSRC, f2 = allowRTCPFB,
 * f3 = videoPayloadCollections, f7 = ltrpEnabled, f8 = pixelFormats,
 * f10 = fecEnabled, f11 = rtxEnabled, f12 = blackFrameOnClearScreenEnabled.
 *
 * `rtxEnabled` is deliberately not exposed: the device rejects it with
 * `Invalid Parameter` because the screen-blob path also wants RTX SSRC fields
 * this offer does not model.
 *
 * @param sessionId Random uint32 identifying the session.
 * @param options Encoder knobs; see {@link VideoMediaBlobOptions}.
 */
export function buildMediaBlobVideo(sessionId: number, options: VideoMediaBlobOptions = {}): Buffer {
  const {
    allowRtcpFb = false,
    ltrpEnabled = false,
    fecEnabled = true,
    tilesPerFrame = 1,
    hevcFeatures = DEFAULT_HEVC_FEATURES,
    avcFeatures = DEFAULT_AVC_FEATURES,
    decoderName = DEFAULT_DECODER_NAME,
    timestamp = CAPTURED_VIDEO_TIMESTAMP,
  } = options;

  const videoSettings = Buffer.concat([
    tag(1, 0),
    varintPadded(sessionId, 5),
    fieldVarint(2, allowRtcpFb ? 1 : 0),
    fieldBytes(3, codecBank(HEVC_PAYLOAD_TYPE, hevcFeatures, 1, 4)),
    fieldBytes(3, codecBank(AVC_PAYLOAD_TYPE, avcFeatures, 14, 2)),
    // Apple's capture omits f6 entirely at the default of 1.
    ...(tilesPerFrame === 1 ? [] : [fieldVarint(6, tilesPerFrame)]),
    fieldVarint(7, ltrpEnabled ? 1 : 0),
    fieldVarint(8, 63),
    ...(fecEnabled ? [fieldVarint(10, 1)] : []),
    fieldVarint(12, 1),
  ]);

  return buildTopLevel({
    settingsField: 5,
    settingsBody: videoSettings,
    decoderName,
    timestamp,
    bitrateTiers: DEFAULT_VIDEO_BITRATE_TIERS,
  });
}

/** Tunables for the audio mediaBlob. */
export interface AudioMediaBlobOptions {
  /** Decoder identity string. */
  decoderName?: string;
  /** Host-clock timestamp field. */
  timestamp?: bigint;
}

/**
 * Builds the audio mediaBlob protobuf. Byte-identical to Apple's captured
 * audio template at the defaults.
 *
 * @param sessionId Random uint32 identifying the session.
 * @param options Encoder knobs; see {@link AudioMediaBlobOptions}.
 */
export function buildMediaBlobAudio(sessionId: number, options: AudioMediaBlobOptions = {}): Buffer {
  const {decoderName = DEFAULT_DECODER_NAME, timestamp = CAPTURED_AUDIO_TIMESTAMP} = options;

  const audioSettings = Buffer.concat([
    tag(1, 0),
    varintPadded(sessionId, 5),
    fieldVarint(2, 0),
    fieldVarint(3, 0),
    fieldVarint(4, 24191),
    fieldVarint(5, 0),
    fieldVarint(6, 0),
  ]);

  return buildTopLevel({
    settingsField: 3,
    settingsBody: audioSettings,
    decoderName,
    timestamp,
    bitrateTiers: DEFAULT_AUDIO_BITRATE_TIERS,
  });
}

/**
 * Builds the `avcMediaStreamOptionRemoteEndpointInfo` protobuf describing the
 * host. A captured macOS host sends `{0, 1, "Mac16,11", "2205.3.1", "25F80"}`.
 */
export function buildRemoteEndpointInfo(identity: HostEndpointIdentity = {}): Buffer {
  const {model, osVersion, build} = {...DEFAULT_HOST_IDENTITY, ...identity};
  return Buffer.concat([
    fieldVarint(1, 0),
    fieldVarint(2, 1),
    fieldString(3, model),
    fieldString(4, osVersion),
    fieldString(5, build),
  ]);
}

// ---------------------------------------------------------------------------
// outer negotiatorOffer binary plist
// ---------------------------------------------------------------------------

/**
 * Compresses the mediaBlob the way Apple does.
 *
 * Level 9 is what Xcode sends (`78da` header). Node's bundled zlib makes
 * slightly different encoder choices than other zlib builds, so the compressed
 * bytes are not identical to pmd3's — but both are valid level-9 streams that
 * inflate to the same protobuf, which is all the device's decompressor sees.
 */
function compressMediaBlob(blob: Buffer): Buffer {
  return deflateSync(blob, {level: 9});
}

function buildOffer(mode: number, mediaBlob: Buffer, callId: string, identity: HostEndpointIdentity): Buffer {
  return createBinaryPlist({
    avcMediaStreamOptionRemoteEndpointInfo: buildRemoteEndpointInfo(identity),
    avcMediaStreamNegotiatorMode: mode,
    avcMediaStreamNegotiatorMediaBlob: compressMediaBlob(mediaBlob),
    avcMediaStreamOptionCallID: callId,
  });
}

/** Options shared by both negotiator-offer builders. */
export interface NegotiatorOfferOptions extends VideoMediaBlobOptions {
  /** Host identity reported in the endpoint info. */
  hostIdentity?: HostEndpointIdentity;
}

/**
 * Builds the full `negotiatorOffer` binary plist for a video stream.
 *
 * @param callId Unique UUID string for this call (`avcMediaStreamOptionCallID`).
 * @param sessionId Random uint32 identifying the session inside the mediaBlob.
 * @param options Host identity plus encoder knobs.
 */
export function buildNegotiatorOfferVideo(
  callId: string,
  sessionId: number,
  options: NegotiatorOfferOptions = {},
): Buffer {
  const {hostIdentity, ...blobOptions} = options;
  return buildOffer(NEGOTIATOR_MODE_VIDEO, buildMediaBlobVideo(sessionId, blobOptions), callId, hostIdentity ?? {});
}

/**
 * Builds the full `negotiatorOffer` binary plist for an audio stream.
 *
 * @param callId Unique UUID string for this call (`avcMediaStreamOptionCallID`).
 * @param sessionId Random uint32 identifying the session inside the mediaBlob.
 * @param options Host identity plus decoder/timestamp knobs.
 */
export function buildNegotiatorOfferAudio(
  callId: string,
  sessionId: number,
  options: AudioMediaBlobOptions & {hostIdentity?: HostEndpointIdentity} = {},
): Buffer {
  const {hostIdentity, ...blobOptions} = options;
  return buildOffer(NEGOTIATOR_MODE_AUDIO, buildMediaBlobAudio(sessionId, blobOptions), callId, hostIdentity ?? {});
}

/** Generates a fresh `avcMediaStreamOptionCallID` (upper-case UUID string). */
export function newCallId(): string {
  return randomUUID().toUpperCase();
}

/** Generates a random uint32 session id for the mediaBlob. */
export function newSessionId(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}
