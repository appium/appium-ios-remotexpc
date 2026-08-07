import {once} from 'node:events';
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
 * mdat                             (sample payloads, back to back)
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
 * ```
 *
 * `moov` comes last — the same layout `ffmpeg` produces without
 * `-movflags +faststart`. That ordering is what makes {@link M4aFileWriter}
 * possible: the sample data starts at a fixed, known offset, so samples can be
 * streamed straight to disk and the index written afterwards from the sizes
 * alone. (With `moov` first, its size depends on the sample count, so nothing
 * can be written until every sample is in hand.) Players read the file whole
 * from disk, so the ordering only matters for progressive HTTP delivery, which
 * is not what these files are for.
 */
import {createWriteStream} from 'node:fs';
import {open} from 'node:fs/promises';

import {AAC_ELD_FORMAT, type AacEldFormat} from './aac-eld.js';

/** Options for {@link buildM4a} and {@link M4aFileWriter.create}. */
export interface BuildM4aOptions {
  /** Audio format description. Defaults to the device's AAC-ELD format. */
  format?: AacEldFormat;
}

/**
 * Largest `mdat` a 32-bit box size can describe. At the device's ~10 KB/s this
 * is over 100 hours of audio, so exceeding it means something else is wrong.
 */
const MAX_MDAT_PAYLOAD = 0xffff_ffff - 8;

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

/**
 * Packs the per-sample size table.
 *
 * Written into one pre-sized buffer rather than mapped to a Buffer per sample
 * and spread into `fullBox`: a spread passes one argument per sample, which
 * overflows the call stack somewhere above 50,000 samples — under nine minutes
 * of audio at 100 access units a second.
 */
function packSampleSizes(sampleSizes: readonly number[]): Buffer {
  const table = Buffer.allocUnsafe(sampleSizes.length * 4);
  for (const [index, size] of sampleSizes.entries()) {
    table.writeUInt32BE(size, index * 4);
  }
  return table;
}

function buildStbl(sampleSizes: readonly number[], format: AacEldFormat, chunkOffset: number): Buffer {
  const sampleCount = sampleSizes.length;
  return box(
    'stbl',
    buildStsd(format),
    // Every access unit is the same duration, so one time-to-sample entry.
    fullBox('stts', 0, 0, u32(1), u32(sampleCount), u32(format.framesPerPacket)),
    // One chunk holding every sample.
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(sampleCount), u32(1)),
    // sample_size 0 means "sizes follow per sample".
    fullBox('stsz', 0, 0, u32(0), u32(sampleCount), packSampleSizes(sampleSizes)),
    fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
  );
}

function buildMoov(sampleSizes: readonly number[], format: AacEldFormat, chunkOffset: number): Buffer {
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
  const minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), dinf, buildStbl(sampleSizes, format, chunkOffset));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);

  return box('moov', mvhd, trak);
}

function buildFtyp(): Buffer {
  return box('ftyp', Buffer.from('M4A ', 'ascii'), u32(0x200), Buffer.from('M4A mp42isom', 'ascii'));
}

/**
 * Builds a single-track `.m4a` from AAC-ELD access units, entirely in memory.
 *
 * The result is a valid MP4 audio file: QuickTime plays it directly, and
 * `ffmpeg -c copy` can remux it alongside a video track without decoding — the
 * intended path for combining a screen recording with its audio.
 *
 * Peak memory is around four times the audio payload: the samples stay live
 * while `Buffer.concat` allocates the joined body, which `box` then copies
 * again. Measured at an hour of real audio (360,000 access units, a 130 MB
 * file), the process peaked at 824 MB. That is fine for a short capture, but
 * for anything open-ended use {@link M4aFileWriter}, which holds only the
 * sample sizes.
 *
 * @param accessUnits One AAC-ELD access unit per element, in capture order.
 * @param options Format override; defaults to the device's AAC-ELD format.
 */
export function buildM4a(accessUnits: readonly Buffer[], options: BuildM4aOptions = {}): Buffer {
  const format = options.format ?? AAC_ELD_FORMAT;
  const sampleSizes = accessUnits.map((au) => au.length);
  const ftyp = buildFtyp();

  // Samples begin right after ftyp and mdat's own 8-byte header.
  const moov = buildMoov(sampleSizes, format, ftyp.length + 8);

  return Buffer.concat([ftyp, box('mdat', Buffer.concat(accessUnits.slice())), moov]);
}

/** What {@link M4aFileWriter.close} reports about the finished file. */
export interface M4aFileWriterResult {
  /** Samples written. */
  sampleCount: number;
  /** Size of the finished file in bytes. */
  bytesWritten: number;
}

/**
 * Writes an `.m4a` incrementally, streaming each access unit to disk as it
 * arrives.
 *
 * A capture is open-ended: the caller chooses the duration, and the device
 * emits ~100 access units a second for as long as it runs. Collecting them in
 * an array first makes memory grow without bound for the whole recording, so
 * this keeps only each sample's size and lets the operating system's page cache
 * own the bytes. With audio actually playing the device streams ~285 kbit/s,
 * averaging 357 bytes an access unit — so an hour is a 130 MB file, and over
 * that hour this retains 3.2 MB against 69.3 MB for the buffered path.
 *
 * Sample payloads land in `mdat` at a fixed offset, so the index can be written
 * afterwards from the sizes alone; the only thing patched at the end is
 * `mdat`'s own length field.
 *
 * @example
 * ```ts
 * const writer = await M4aFileWriter.create('audio.m4a');
 * try {
 *   for await (const unit of capture.accessUnits()) {
 *     await writer.write(unit.data);
 *   }
 * } finally {
 *   const {bytesWritten} = await writer.close();
 * }
 * ```
 */
export class M4aFileWriter {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private readonly sampleSizes: number[] = [];
  private readonly headerLength: number;

  private payloadBytes = 0;
  private closePromise: Promise<M4aFileWriterResult> | undefined;
  /** First write error seen, re-thrown from the next `write` or `close`. */
  private streamError: Error | undefined;

  private constructor(
    readonly path: string,
    private readonly format: AacEldFormat,
    stream: ReturnType<typeof createWriteStream>,
    headerLength: number,
  ) {
    this.stream = stream;
    this.headerLength = headerLength;
    // A recording runs unattended for minutes; without a listener, a write that
    // fails after the fact (a full disk, an unplugged volume) reaches the
    // process as an uncaught 'error' event and takes it down. Holding the first
    // one turns that into a rejection the caller can see.
    this.stream.on('error', (error: Error) => {
      this.streamError ??= error;
    });
  }

  /**
   * Creates the file and writes the fixed header, leaving it ready for samples.
   *
   * @param path Destination `.m4a` path; truncated if it exists.
   * @param options Format override; defaults to the device's AAC-ELD format.
   */
  static async create(path: string, options: BuildM4aOptions = {}): Promise<M4aFileWriter> {
    const format = options.format ?? AAC_ELD_FORMAT;
    const ftyp = buildFtyp();
    // mdat's length is unknown until the stream ends; a placeholder holds the
    // slot, and close() rewrites it in place.
    const mdatHeader = Buffer.alloc(8);
    mdatHeader.write('mdat', 4, 'ascii');

    const stream = createWriteStream(path);
    await once(stream, 'open');
    const writer = new M4aFileWriter(path, format, stream, ftyp.length + mdatHeader.length);
    await writer.push(Buffer.concat([ftyp, mdatHeader]));
    return writer;
  }

  /** Samples written so far. */
  get sampleCount(): number {
    return this.sampleSizes.length;
  }

  /**
   * Appends one access unit.
   *
   * Resolves once the stream has room for more, so an `await` per unit applies
   * backpressure instead of letting the write queue grow.
   *
   * @param accessUnit One encoded AAC-ELD access unit.
   */
  async write(accessUnit: Buffer): Promise<void> {
    if (this.closePromise) {
      throw new Error('Cannot write to an M4aFileWriter that is closing or closed');
    }
    if (accessUnit.length === 0) {
      return;
    }
    if (this.payloadBytes + accessUnit.length > MAX_MDAT_PAYLOAD) {
      throw new Error(`Audio exceeds the ${MAX_MDAT_PAYLOAD} byte limit of a 32-bit mdat box`);
    }
    this.sampleSizes.push(accessUnit.length);
    this.payloadBytes += accessUnit.length;
    await this.push(accessUnit);
  }

  /**
   * Writes the index, patches `mdat`'s length and closes the file. Safe to call
   * more than once; later calls await the first.
   */
  async close(): Promise<M4aFileWriterResult> {
    this.closePromise ??= this.finalize();
    return this.closePromise;
  }

  private async finalize(): Promise<M4aFileWriterResult> {
    const moov = buildMoov(this.sampleSizes, this.format, this.headerLength);
    await this.push(moov);
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null): void => (error ? reject(error) : resolve()));
    });

    // The mdat header sits immediately after ftyp; only its size field changes.
    const handle = await open(this.path, 'r+');
    try {
      await handle.write(u32(this.payloadBytes + 8), 0, 4, this.headerLength - 8);
    } finally {
      await handle.close();
    }

    return {
      sampleCount: this.sampleSizes.length,
      bytesWritten: this.headerLength + this.payloadBytes + moov.length,
    };
  }

  private async push(chunk: Buffer): Promise<void> {
    if (this.streamError) {
      throw this.streamError;
    }
    if (!this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
    if (this.streamError) {
      throw this.streamError;
    }
  }
}
