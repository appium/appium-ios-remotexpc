import {describe, it} from 'node:test';

import {expect} from 'chai';

import {AAC_ELD_ASC_48K_STEREO_480, AAC_ELD_FORMAT} from '../../../src/services/ios/display/aac-eld.js';
import {buildM4a} from '../../../src/services/ios/display/m4a-writer.js';

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
    it('emits ftyp, moov and mdat in order', function () {
      const file = buildM4a(samples);

      expect(topLevelBoxes(file).map(([type]) => type)).to.deep.equal(['ftyp', 'moov', 'mdat']);
    });

    it('box sizes account for the whole file', function () {
      const file = buildM4a(samples);

      const total = topLevelBoxes(file).reduce((sum, [, size]) => sum + size, 0);
      expect(total).to.equal(file.length);
    });

    it('declares an M4A brand', function () {
      const file = buildM4a(samples);

      expect(file.toString('ascii', 8, 12)).to.equal('M4A ');
    });
  });

  describe('sample table', function () {
    it('records every sample size in stsz', function () {
      const file = buildM4a(samples);
      const stsz = findBox(file, 'stsz')!;

      // [1 version][3 flags][4 sample_size][4 sample_count][sizes...]
      expect(stsz.readUInt32BE(4)).to.equal(0); // 0 => per-sample sizes follow
      expect(stsz.readUInt32BE(8)).to.equal(samples.length);
      const sizes = samples.map((_, i) => stsz.readUInt32BE(12 + i * 4));
      expect(sizes).to.deep.equal(samples.map((s) => s.length));
    });

    it('gives every sample the same duration of one frame block', function () {
      const file = buildM4a(samples);
      const stts = findBox(file, 'stts')!;

      expect(stts.readUInt32BE(4)).to.equal(1); // one entry covers all samples
      expect(stts.readUInt32BE(8)).to.equal(samples.length);
      expect(stts.readUInt32BE(12)).to.equal(AAC_ELD_FORMAT.framesPerPacket);
    });

    it('points stco at the actual mdat payload', function () {
      const file = buildM4a(samples);
      const stco = findBox(file, 'stco')!;
      const chunkOffset = stco.readUInt32BE(8);

      // The offset must land exactly on the first sample's bytes.
      expect(file.subarray(chunkOffset, chunkOffset + samples[0].length)).to.deep.equal(samples[0]);
    });

    it('concatenates the samples into mdat in order', function () {
      const file = buildM4a(samples);
      const stco = findBox(file, 'stco')!;
      let offset = stco.readUInt32BE(8);

      for (const sample of samples) {
        expect(file.subarray(offset, offset + sample.length)).to.deep.equal(sample);
        offset += sample.length;
      }
    });
  });

  describe('esds / codec configuration', function () {
    it('embeds the AudioSpecificConfig', function () {
      const file = buildM4a(samples);

      expect(file.includes(AAC_ELD_ASC_48K_STEREO_480)).to.equal(true);
    });

    it('marks the stream as MPEG-4 audio', function () {
      const file = buildM4a(samples);
      const esds = findBox(file, 'esds')!;

      // objectTypeIndication 0x40 = MPEG-4 Audio, streamType 0x05 = audio.
      const decoderConfigTag = esds.indexOf(0x04);
      expect(esds[decoderConfigTag + 2]).to.equal(0x40);
      expect(esds[decoderConfigTag + 3]).to.equal(0x15);
    });

    it('honours a custom format', function () {
      const asc = Buffer.from([0x12, 0x34]);
      const file = buildM4a(samples, {
        format: {sampleRate: 44100, channels: 1, framesPerPacket: 1024, audioSpecificConfig: asc},
      });

      expect(file.includes(asc)).to.equal(true);
      expect(findBox(file, 'stts')!.readUInt32BE(12)).to.equal(1024);
      // mdhd timescale must follow the sample rate.
      expect(findBox(file, 'mdhd')!.readUInt32BE(12)).to.equal(44100);
    });
  });

  describe('durations', function () {
    it('writes the total duration in the media timescale', function () {
      const file = buildM4a(samples);
      const mdhd = findBox(file, 'mdhd')!;

      expect(mdhd.readUInt32BE(12)).to.equal(AAC_ELD_FORMAT.sampleRate); // timescale
      expect(mdhd.readUInt32BE(16)).to.equal(samples.length * AAC_ELD_FORMAT.framesPerPacket);
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

      expect(sampleRateFixed).to.equal(48000 * 0x10000);
      expect(sampleRateFixed).to.equal(3145728000);
    });
  });

  describe('edge cases', function () {
    it('produces a structurally valid file with no samples', function () {
      const file = buildM4a([]);

      expect(topLevelBoxes(file).map(([type]) => type)).to.deep.equal(['ftyp', 'moov', 'mdat']);
      expect(findBox(file, 'stsz')!.readUInt32BE(8)).to.equal(0);
      expect(findBox(file, 'mdhd')!.readUInt32BE(16)).to.equal(0);
    });

    it('handles a single sample', function () {
      const file = buildM4a([AU(0x99, 12)]);

      expect(findBox(file, 'stsz')!.readUInt32BE(8)).to.equal(1);
      const chunkOffset = findBox(file, 'stco')!.readUInt32BE(8);
      expect(file.subarray(chunkOffset, chunkOffset + 12)).to.deep.equal(AU(0x99, 12));
    });

    it('encodes descriptor lengths above 127 as multi-byte', function () {
      // A long ASC forces the DecoderSpecificInfo length past one VLQ byte.
      const asc = Buffer.alloc(200, 0xab);
      const file = buildM4a(samples, {format: {...AAC_ELD_FORMAT, audioSpecificConfig: asc}});

      expect(file.includes(asc)).to.equal(true);
      // Total size still consistent, i.e. the VLQ length did not corrupt boxes.
      expect(topLevelBoxes(file).reduce((sum, [, size]) => sum + size, 0)).to.equal(file.length);
    });
  });
});
