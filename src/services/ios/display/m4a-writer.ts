/**
 * Minimal MP4 (`.m4a`) writer for the device's AAC-ELD audio access units.
 *
 * The access units cannot be written as a raw stream — AAC-ELD has no valid
 * ADTS representation (see `aac-eld.ts`) — so a container is the only portable
 * way to hand the audio to other tools. This produces a single-track audio MP4
 * whose `esds` carries the `AudioSpecificConfig`, which is what tells a decoder
 * the stream is ELD with 480-sample frames.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: the box layout
 * needed here is fixed and small, and it keeps the library dependency-free.
 *
 * Box layout:
 * ```
 * ftyp
 * moov
 *   mvhd
 *   trak
 *     tkhd
 *     mdia
 *       mdhd, hdlr
 *       minf
 *         smhd, dinf/dref/url
 *         stbl
 *           stsd -> mp4a -> esds   (AudioSpecificConfig)
 *           stts, stsc, stsz, stco
 * mdat
 * ```
 */
import {AAC_ELD_FORMAT, type AacEldFormat} from './aac-eld.js';

/** Options for {@link buildM4a}. */
export interface BuildM4aOptions {
  /** Audio format description. Defaults to the device's AAC-ELD format. */
  format?: AacEldFormat;
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(version, 0);
  head.writeUIntBE(flags, 1, 3);
  return box(type, head, ...payload);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

/**
 * Encodes an MPEG-4 descriptor: 1-byte tag, then the length as a
 * variable-length quantity (7 bits per byte, high bit = continuation).
 */
function descriptor(tag: number, payload: Buffer): Buffer {
  const lengthBytes: number[] = [];
  let remaining = payload.length;
  do {
    lengthBytes.unshift(remaining & 0x7f);
    remaining >>= 7;
  } while (remaining > 0);
  for (let i = 0; i < lengthBytes.length - 1; i++) {
    lengthBytes[i] |= 0x80;
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from(lengthBytes), payload]);
}

/** Builds the `esds` box carrying the AudioSpecificConfig. */
function buildEsds(audioSpecificConfig: Buffer): Buffer {
  // DecoderSpecificInfo (tag 0x05) — the AudioSpecificConfig itself.
  const decoderSpecificInfo = descriptor(0x05, audioSpecificConfig);

  // DecoderConfigDescriptor (tag 0x04):
  //   objectTypeIndication 0x40 = MPEG-4 Audio (the ASC states ELD),
  //   streamType 0x05 = audio, upStream 0, reserved 1 -> 0x15,
  //   then bufferSizeDB(24) + maxBitrate(32) + avgBitrate(32), left at 0
  //   because the device never tells us and no decoder requires them.
  const decoderConfig = descriptor(
    0x04,
    Buffer.concat([
      Buffer.from([0x40, 0x15]),
      Buffer.from([0x00, 0x00, 0x00]), // bufferSizeDB
      u32(0), // maxBitrate
      u32(0), // avgBitrate
      decoderSpecificInfo,
    ]),
  );

  // SLConfigDescriptor (tag 0x06): 0x02 = "predefined MP4" timing.
  const slConfig = descriptor(0x06, Buffer.from([0x02]));

  // ES_Descriptor (tag 0x03): ES_ID 1, no flags.
  const esDescriptor = descriptor(0x03, Buffer.concat([u16(1), Buffer.from([0x00]), decoderConfig, slConfig]));

  return fullBox('esds', 0, 0, esDescriptor);
}

function buildStsd(format: AacEldFormat): Buffer {
  const mp4a = box(
    'mp4a',
    Buffer.alloc(6), // reserved
    u16(1), // data_reference_index
    Buffer.alloc(8), // reserved (version, revision, vendor)
    u16(format.channels),
    u16(16), // sample size in bits
    Buffer.alloc(4), // pre_defined + reserved
    // 16.16 fixed-point sample rate; the real rate also lives in mdhd.
    // Multiplied rather than shifted: `48000 << 16` overflows JS's 32-bit
    // signed bitwise operators and wraps negative.
    u32(format.sampleRate * 0x10000),
    buildEsds(format.audioSpecificConfig),
  );
  return fullBox('stsd', 0, 0, u32(1), mp4a);
}

function buildStbl(sampleSizes: readonly number[], format: AacEldFormat): Buffer {
  const sampleCount = sampleSizes.length;
  return box(
    'stbl',
    buildStsd(format),
    // Every access unit is the same duration, so one time-to-sample entry.
    fullBox('stts', 0, 0, u32(1), u32(sampleCount), u32(format.framesPerPacket)),
    // One chunk holding every sample.
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(sampleCount), u32(1)),
    // sample_size 0 means "sizes follow per sample".
    fullBox('stsz', 0, 0, u32(0), u32(sampleCount), ...sampleSizes.map(u32)),
    // Patched to the real mdat offset by the caller's second pass.
    fullBox('stco', 0, 0, u32(1), u32(0)),
  );
}

function buildMoov(sampleSizes: readonly number[], format: AacEldFormat): Buffer {
  const sampleCount = sampleSizes.length;
  const durationInTimescale = sampleCount * format.framesPerPacket;

  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(format.sampleRate), // timescale — use the audio rate so durations are exact
    u32(durationInTimescale),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    Buffer.alloc(10), // reserved
    // Unity transformation matrix.
    Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    Buffer.alloc(24), // pre_defined
    u32(2), // next_track_ID
  );

  const tkhd = fullBox(
    'tkhd',
    0,
    0x000007, // enabled | in movie | in preview
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1), // track_ID
    u32(0), // reserved
    u32(durationInTimescale),
    Buffer.alloc(8), // reserved
    u16(0), // layer
    u16(1), // alternate_group
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    u32(0), // width (audio track)
    u32(0), // height
  );

  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(format.sampleRate),
    u32(durationInTimescale),
    u16(0x55c4), // language 'und'
    u16(0), // pre_defined
  );

  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre_defined
    Buffer.from('soun', 'ascii'),
    Buffer.alloc(12), // reserved
    Buffer.from([0x00]), // empty name
  );

  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), dinf, buildStbl(sampleSizes, format));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);

  return box('moov', mvhd, trak);
}

/**
 * Builds a single-track `.m4a` from AAC-ELD access units.
 *
 * The result is a valid MP4 audio file: QuickTime plays it directly, and
 * `ffmpeg -c copy` can remux it alongside a video track without decoding — the
 * intended path for combining a screen recording with its audio.
 *
 * @param accessUnits One AAC-ELD access unit per element, in capture order.
 * @param options Format override; defaults to the device's AAC-ELD format.
 */
export function buildM4a(accessUnits: readonly Buffer[], options: BuildM4aOptions = {}): Buffer {
  const format = options.format ?? AAC_ELD_FORMAT;
  const sampleSizes = accessUnits.map((au) => au.length);
  const mdatBody = Buffer.concat(accessUnits.slice());

  const ftyp = box('ftyp', Buffer.from('M4A ', 'ascii'), u32(0x200), Buffer.from('M4A mp42isom', 'ascii'));

  // Two passes: the sample data's absolute offset depends on the size of moov,
  // and moov contains that offset. Its size is stable (stco holds a fixed
  // 4-byte value), so measuring once and rebuilding is exact.
  const provisionalMoov = buildMoov(sampleSizes, format);
  const mdatOffset = ftyp.length + provisionalMoov.length + 8;

  const moov = buildMoov(sampleSizes, format);
  patchChunkOffset(moov, mdatOffset);

  return Buffer.concat([ftyp, moov, box('mdat', mdatBody)]);
}

/**
 * Rewrites the single `stco` entry to `offset`.
 *
 * `buildMoov` emits a placeholder because the value is only known once moov's
 * own size is; patching in place avoids threading the offset through every
 * box builder.
 */
function patchChunkOffset(moov: Buffer, offset: number): void {
  const stcoIndex = moov.indexOf('stco', 0, 'ascii');
  if (stcoIndex < 0) {
    throw new Error('Malformed moov: no stco box');
  }
  // stco: [4 size][4 'stco'][1 version][3 flags][4 entry_count][4 offset]
  moov.writeUInt32BE(offset, stcoIndex + 4 + 4 + 4);
}
