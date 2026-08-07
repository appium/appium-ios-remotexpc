import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import {AAC_ELD_ASC_48K_STEREO_480, AAC_ELD_FORMAT} from '../../../../src/services/ios/display/audio/aac-eld.js';
import {M4aFileWriter, buildM4a} from '../../../../src/services/ios/display/audio/m4a-writer.js';

/** Walks top-level MP4 boxes, returning [type, size] pairs in order. */
function topLevelBoxes(file: Buffer): Array<[string, number]> {
  const boxes: Array<[string, number]> = [];
  let offset = 0;
  while (offset + 8 <= file.length) {
    const size = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    boxes.push([type, size]);
    if (size <= 0) {
      break;
    }
    offset += size;
  }
  return boxes;
}

/** Finds a box by type anywhere in the file, returning its payload. */
function findBox(file: Buffer, type: string): Buffer | undefined {
  const index = file.indexOf(type, 0, 'ascii');
  if (index < 4) {
    return undefined;
  }
  const size = file.readUInt32BE(index - 4);
  return file.subarray(index + 4, index - 4 + size);
}

const AU = (byte: number, length: number): Buffer => Buffer.alloc(length, byte);

describe('buildM4a', function () {
  const samples = [AU(0x11, 40), AU(0x22, 55), AU(0x33, 48)];

  describe('container structure', function () {
    it('emits ftyp, mdat and moov in order', function () {
      const file = buildM4a(samples);

      // moov last, so the sample data sits at a fixed offset and the same
      // layout can be produced incrementally by M4aFileWriter.
      assert.deepStrictEqual(
        topLevelBoxes(file).map(([type]) => type),
        ['ftyp', 'mdat', 'moov'],
      );
    });

    it('box sizes account for the whole file', function () {
      const file = buildM4a(samples);

      const total = topLevelBoxes(file).reduce((sum, [, size]) => sum + size, 0);
      assert.strictEqual(total, file.length);
    });

    it('declares an M4A brand', function () {
      const file = buildM4a(samples);

      assert.strictEqual(file.toString('ascii', 8, 12), 'M4A ');
    });
  });

  describe('sample table', function () {
    it('records every sample size in stsz', function () {
      const file = buildM4a(samples);
      const stsz = findBox(file, 'stsz')!;

      // [1 version][3 flags][4 sample_size][4 sample_count][sizes...]
      assert.strictEqual(stsz.readUInt32BE(4), 0); // 0 => per-sample sizes follow
      assert.strictEqual(stsz.readUInt32BE(8), samples.length);
      const sizes = samples.map((_, i) => stsz.readUInt32BE(12 + i * 4));
      assert.deepStrictEqual(
        sizes,
        samples.map((s) => s.length),
      );
    });

    it('gives every sample the same duration of one frame block', function () {
      const file = buildM4a(samples);
      const stts = findBox(file, 'stts')!;

      assert.strictEqual(stts.readUInt32BE(4), 1); // one entry covers all samples
      assert.strictEqual(stts.readUInt32BE(8), samples.length);
      assert.strictEqual(stts.readUInt32BE(12), AAC_ELD_FORMAT.framesPerPacket);
    });

    it('points stco at the actual mdat payload', function () {
      const file = buildM4a(samples);
      const stco = findBox(file, 'stco')!;
      const chunkOffset = stco.readUInt32BE(8);

      // The offset must land exactly on the first sample's bytes.
      assert.deepStrictEqual(file.subarray(chunkOffset, chunkOffset + samples[0].length), samples[0]);
    });

    it('concatenates the samples into mdat in order', function () {
      const file = buildM4a(samples);
      const stco = findBox(file, 'stco')!;
      let offset = stco.readUInt32BE(8);

      for (const sample of samples) {
        assert.deepStrictEqual(file.subarray(offset, offset + sample.length), sample);
        offset += sample.length;
      }
    });
  });

  describe('esds / codec configuration', function () {
    it('embeds the AudioSpecificConfig', function () {
      const file = buildM4a(samples);

      assert.strictEqual(file.includes(AAC_ELD_ASC_48K_STEREO_480), true);
    });

    it('marks the stream as MPEG-4 audio', function () {
      const file = buildM4a(samples);
      const esds = findBox(file, 'esds')!;

      // objectTypeIndication 0x40 = MPEG-4 Audio, streamType 0x05 = audio.
      const decoderConfigTag = esds.indexOf(0x04);
      assert.strictEqual(esds[decoderConfigTag + 2], 0x40);
      assert.strictEqual(esds[decoderConfigTag + 3], 0x15);
    });

    it('honours a custom format', function () {
      const asc = Buffer.from([0x12, 0x34]);
      const file = buildM4a(samples, {
        format: {sampleRate: 44100, channels: 1, framesPerPacket: 1024, audioSpecificConfig: asc},
      });

      assert.strictEqual(file.includes(asc), true);
      assert.strictEqual(findBox(file, 'stts')!.readUInt32BE(12), 1024);
      // mdhd timescale must follow the sample rate.
      assert.strictEqual(findBox(file, 'mdhd')!.readUInt32BE(12), 44100);
    });
  });

  describe('durations', function () {
    it('writes the total duration in the media timescale', function () {
      const file = buildM4a(samples);
      const mdhd = findBox(file, 'mdhd')!;

      assert.strictEqual(mdhd.readUInt32BE(12), AAC_ELD_FORMAT.sampleRate); // timescale
      assert.strictEqual(mdhd.readUInt32BE(16), samples.length * AAC_ELD_FORMAT.framesPerPacket);
    });

    it('writes a 16.16 fixed-point sample rate without overflowing', function () {
      // 48000 << 16 overflows JS's signed 32-bit bitwise ops; this guards the
      // multiplication used instead.
      const file = buildM4a(samples);
      const stsd = findBox(file, 'stsd')!;
      // AudioSampleEntry body: 6 reserved + 2 dref + 8 reserved + 2 channels
      // + 2 samplesize + 4 pre_defined = samplerate at body offset 24.
      const mp4aBody = stsd.indexOf('mp4a', 0, 'ascii') + 4;
      const sampleRateFixed = stsd.readUInt32BE(mp4aBody + 24);

      assert.strictEqual(sampleRateFixed, 48000 * 0x10000);
      assert.strictEqual(sampleRateFixed, 3145728000);
    });
  });

  describe('edge cases', function () {
    it('produces a structurally valid file with no samples', function () {
      const file = buildM4a([]);

      assert.deepStrictEqual(
        topLevelBoxes(file).map(([type]) => type),
        ['ftyp', 'mdat', 'moov'],
      );
      assert.strictEqual(findBox(file, 'stsz')!.readUInt32BE(8), 0);
      assert.strictEqual(findBox(file, 'mdhd')!.readUInt32BE(16), 0);
    });

    it('handles a single sample', function () {
      const file = buildM4a([AU(0x99, 12)]);

      assert.strictEqual(findBox(file, 'stsz')!.readUInt32BE(8), 1);
      const chunkOffset = findBox(file, 'stco')!.readUInt32BE(8);
      assert.deepStrictEqual(file.subarray(chunkOffset, chunkOffset + 12), AU(0x99, 12));
    });

    it('indexes a sample count no spread could pass as arguments', function () {
      // Building stsz by spreading one Buffer per sample overflowed the call
      // stack above ~52,000 samples — under nine minutes of audio at 100 access
      // units a second, i.e. well inside what a recording actually reaches.
      const count = 400_000; // a bit over an hour
      const file = buildM4a(Array.from({length: count}, () => AU(0x7f, 6)));

      const stsz = findBox(file, 'stsz')!;
      assert.strictEqual(stsz.readUInt32BE(8), count);
      // Spot-check the ends of the table, not just its declared length.
      assert.strictEqual(stsz.readUInt32BE(12), 6);
      assert.strictEqual(stsz.readUInt32BE(12 + (count - 1) * 4), 6);
    });

    it('encodes descriptor lengths above 127 as multi-byte', function () {
      // A long ASC forces the DecoderSpecificInfo length past one VLQ byte.
      const asc = Buffer.alloc(200, 0xab);
      const file = buildM4a(samples, {format: {...AAC_ELD_FORMAT, audioSpecificConfig: asc}});

      assert.strictEqual(file.includes(asc), true);
      // Total size still consistent, i.e. the VLQ length did not corrupt boxes.
      assert.strictEqual(
        topLevelBoxes(file).reduce((sum, [, size]) => sum + size, 0),
        file.length,
      );
    });
  });
});

describe('M4aFileWriter', function () {
  let directory: string;
  let counter = 0;

  before(async function () {
    directory = await mkdtemp(join(tmpdir(), 'm4a-writer-'));
  });

  after(async function () {
    await rm(directory, {force: true, recursive: true});
  });

  /** Streams `units` through a writer and reads the finished file back. */
  async function writeFile(
    units: readonly Buffer[],
  ): Promise<{file: Buffer; sampleCount: number; bytesWritten: number}> {
    const path = join(directory, `stream-${counter++}.m4a`);
    const writer = await M4aFileWriter.create(path);
    for (const unit of units) {
      await writer.write(unit);
    }
    const result = await writer.close();
    return {file: await readFile(path), ...result};
  }

  const samples = [AU(0x11, 40), AU(0x22, 55), AU(0x33, 48)];

  it('produces byte-identical output to the in-memory builder', async function () {
    // The streaming path must not be a second, subtly different encoder — this
    // is what lets the exhaustive buildM4a tests above cover both.
    const {file} = await writeFile(samples);

    assert.deepStrictEqual(file, buildM4a(samples));
  });

  it('reports the real file size and sample count', async function () {
    const {file, sampleCount, bytesWritten} = await writeFile(samples);

    assert.strictEqual(sampleCount, samples.length);
    assert.strictEqual(bytesWritten, file.length);
  });

  it('patches the mdat length once the stream ends', async function () {
    const {file} = await writeFile(samples);

    const [, [mdatType, mdatSize]] = topLevelBoxes(file);
    assert.strictEqual(mdatType, 'mdat');
    // The placeholder written up front is zero; it must have been rewritten to
    // cover the header plus every sample.
    assert.strictEqual(mdatSize, 8 + samples.reduce((sum, s) => sum + s.length, 0));
  });

  it('handles a file with no samples at all', async function () {
    const {file, sampleCount} = await writeFile([]);

    assert.strictEqual(sampleCount, 0);
    assert.deepStrictEqual(file, buildM4a([]));
  });

  it('ignores empty access units rather than indexing zero-length samples', async function () {
    const {file, sampleCount} = await writeFile([AU(0x11, 40), Buffer.alloc(0), AU(0x22, 55)]);

    assert.strictEqual(sampleCount, 2);
    assert.deepStrictEqual(file, buildM4a([AU(0x11, 40), AU(0x22, 55)]));
  });

  it('is safe to close more than once', async function () {
    const path = join(directory, `double-close.m4a`);
    const writer = await M4aFileWriter.create(path);
    await writer.write(AU(0x11, 40));

    const first = await writer.close();
    const second = await writer.close();

    assert.deepStrictEqual(second, first);
    // A second close must not append a second moov.
    assert.strictEqual((await readFile(path)).length, first.bytesWritten);
  });

  it('rejects rather than crashing the process when the file cannot be opened', async function () {
    // A stream 'error' with no listener is an uncaught exception, which during
    // an unattended recording would take the whole process down.
    await assert.rejects(() => M4aFileWriter.create(join(directory, 'no', 'such', 'dir', 'x.m4a')));
  });

  it('surfaces a write failure through the next call', async function () {
    const writer = await M4aFileWriter.create(join(directory, 'broken.m4a'));
    await writer.write(AU(0x11, 40));

    // Stand in for a disk filling up mid-recording.
    (writer as unknown as {streamError: Error}).streamError = new Error('ENOSPC');

    await assert.rejects(() => writer.write(AU(0x22, 40)), /ENOSPC/);
    await assert.rejects(() => writer.close(), /ENOSPC/);
  });

  it('rejects writes after close', async function () {
    const writer = await M4aFileWriter.create(join(directory, 'closed.m4a'));
    await writer.close();

    await assert.rejects(() => writer.write(AU(0x11, 40)), /closing or closed/);
  });

  it('tracks the sample count as it goes', async function () {
    const writer = await M4aFileWriter.create(join(directory, 'progress.m4a'));
    try {
      assert.strictEqual(writer.sampleCount, 0);
      await writer.write(AU(0x11, 40));
      assert.strictEqual(writer.sampleCount, 1);
      await writer.write(AU(0x22, 55));
      assert.strictEqual(writer.sampleCount, 2);
    } finally {
      await writer.close();
    }
  });
});
