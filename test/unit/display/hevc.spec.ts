import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  HevcDepacketizer,
  HevcNalType,
  buildHevcDecoderConfigurationRecord,
  hevcCodecStringFromSps,
  isKeyNalType,
  nalTypeOf,
  toAnnexB,
  toLengthPrefixed,
} from '../../../src/services/ios/display/hevc.js';

/** Builds the 2-byte HEVC NAL header for `nalType` (layer 0, tid 1). */
function nalHeader(nalType: number): Buffer {
  return Buffer.from([(nalType << 1) & 0x7e, 0x01]);
}

/** Builds a complete NAL unit of `nalType` with `payload` as its body. */
function makeNal(nalType: number, payload: Buffer): Buffer {
  return Buffer.concat([nalHeader(nalType), payload]);
}

/** Wraps `data` in an RFC 7798 fragmentation unit. */
function makeFu(originalNalType: number, data: Buffer, start: boolean, end: boolean): Buffer {
  const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | originalNalType;
  return Buffer.concat([nalHeader(HevcNalType.FU), Buffer.from([fuHeader]), data]);
}

/**
 * The 14-byte proprietary footer Apple's DisplayService appends after the last
 * fragment of each coded-slice NAL. Not part of the HEVC bitstream.
 */
const DISPLAY_SERVICE_TRAILER = Buffer.from('04f00ac0000003000004ec0ab003', 'hex');

/**
 * Inserts HEVC emulation-prevention bytes (`00 00 00|01|02|03` →
 * `00 00 03 ...`), the way a real encoder writes a NAL payload. The parser has
 * to undo this before reading the bitstream.
 */
function escapeRbsp(rbsp: Buffer): Buffer {
  const out: number[] = [];
  let zeroRun = 0;
  for (const byte of rbsp) {
    if (zeroRun >= 2 && byte <= 0x03) {
      out.push(0x03);
      zeroRun = 0;
    }
    out.push(byte);
    zeroRun = byte === 0 ? zeroRun + 1 : 0;
  }
  return Buffer.from(out);
}

/**
 * RBSP of a Main-profile, main-tier, level-4.0 SPS.
 *
 * Byte 0 is `vps_id(4) | max_sub_layers_minus1(3) | nesting(1)`; bytes 1..12
 * are the `profile_tier_level` that both the codec string and the hvcC record
 * are derived from. The runs of zeroes mean the encoded NAL carries
 * emulation-prevention bytes, so this fixture exercises the unescaping too.
 */
const SAMPLE_SPS_RBSP = Buffer.from([
  0x01, // vps_id=0, max_sub_layers_minus1=0, nesting=1
  0x01, // profile_space=0, tier=0 (main), profile_idc=1 (Main)
  0x60,
  0x00,
  0x00,
  0x00, // general_profile_compatibility_flags (32b)
  0x90,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // general_constraint_indicator_flags (48b)
  0x78, // general_level_idc = 120 (level 4.0)
]);

const SAMPLE_SPS = Buffer.concat([nalHeader(HevcNalType.SPS), escapeRbsp(SAMPLE_SPS_RBSP)]);

/** The profile_tier_level hvcC copies verbatim: RBSP bytes 1..12. */
const SAMPLE_SPS_PTL = SAMPLE_SPS_RBSP.subarray(1, 13);

describe('HEVC helpers', function () {
  describe('nalTypeOf / isKeyNalType', function () {
    it('reads the 6-bit NAL type out of the header', function () {
      assert.strictEqual(nalTypeOf(nalHeader(HevcNalType.SPS)), 33);
      assert.strictEqual(nalTypeOf(nalHeader(HevcNalType.FU)), 49);
      assert.strictEqual(nalTypeOf(nalHeader(HevcNalType.IDR_W_RADL)), 19);
    });

    it('classifies only IDR and CRA units as keyframes', function () {
      assert.strictEqual(isKeyNalType(HevcNalType.IDR_W_RADL), true);
      assert.strictEqual(isKeyNalType(HevcNalType.IDR_N_LP), true);
      assert.strictEqual(isKeyNalType(HevcNalType.CRA), true);
      assert.strictEqual(isKeyNalType(1), false); // TRAIL_R (delta)
      assert.strictEqual(isKeyNalType(HevcNalType.SPS), false);
    });
  });

  describe('HevcDepacketizer', function () {
    it('passes a single NAL packet straight through', function () {
      const depacketizer = new HevcDepacketizer();
      const nal = makeNal(1, Buffer.from('slice-data'));

      assert.deepStrictEqual(depacketizer.push(nal), [nal]);
    });

    it('splits an aggregation packet into its NAL units', function () {
      const depacketizer = new HevcDepacketizer();
      const first = makeNal(HevcNalType.VPS, Buffer.from('vps'));
      const second = makeNal(HevcNalType.SPS, Buffer.from('sps'));
      const sizePrefix = (nal: Buffer): Buffer => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(nal.length, 0);
        return prefix;
      };
      const ap = Buffer.concat([nalHeader(HevcNalType.AP), sizePrefix(first), first, sizePrefix(second), second]);

      assert.deepStrictEqual(depacketizer.push(ap), [first, second]);
    });

    it('reassembles a fragmented NAL across three packets', function () {
      const depacketizer = new HevcDepacketizer();
      const body = Buffer.from('abcdefghijkl');

      assert.deepStrictEqual(depacketizer.push(makeFu(1, body.subarray(0, 4), true, false)), []);
      assert.deepStrictEqual(depacketizer.push(makeFu(1, body.subarray(4, 8), false, false)), []);
      const completed = depacketizer.push(makeFu(1, body.subarray(8), false, true));

      assert.strictEqual(completed.length, 1);
      // The original NAL header must be reconstructed from the FU header's type.
      assert.strictEqual(nalTypeOf(completed[0]), 1);
      assert.deepStrictEqual(completed[0].subarray(2), body);
    });

    it('drops a fragment continuation with no preceding start packet', function () {
      const depacketizer = new HevcDepacketizer();

      // Joining mid-NAL: there is no header to rebuild, so nothing can be emitted.
      assert.deepStrictEqual(depacketizer.push(makeFu(1, Buffer.from('tail'), false, true)), []);
    });

    it('discards in-flight fragments on reset', function () {
      const depacketizer = new HevcDepacketizer();
      depacketizer.push(makeFu(1, Buffer.from('head'), true, false));

      depacketizer.reset();

      // Without the start fragment the remainder must not be emitted, otherwise
      // a packet loss would stitch two halves of different NALs together.
      assert.deepStrictEqual(depacketizer.push(makeFu(1, Buffer.from('tail'), false, true)), []);
    });

    it("strips Apple's proprietary trailer from a reassembled NAL", function () {
      const depacketizer = new HevcDepacketizer();
      const body = Buffer.from('slice');

      depacketizer.push(makeFu(1, body, true, false));
      const completed = depacketizer.push(makeFu(1, DISPLAY_SERVICE_TRAILER, false, true));

      assert.strictEqual(completed.length, 1);
      assert.deepStrictEqual(completed[0].subarray(2), body);
    });

    it('strips the trailer from a single-packet NAL too', function () {
      const depacketizer = new HevcDepacketizer();
      const nal = makeNal(1, Buffer.concat([Buffer.from('slice'), DISPLAY_SERVICE_TRAILER]));

      const [result] = depacketizer.push(nal);

      assert.deepStrictEqual(result.subarray(2), Buffer.from('slice'));
    });

    it('leaves a NAL without the trailer untouched', function () {
      const depacketizer = new HevcDepacketizer();
      const nal = makeNal(1, Buffer.from('no trailer here'));

      assert.deepStrictEqual(depacketizer.push(nal), [nal]);
    });

    it('ignores packets too short to carry a NAL header', function () {
      const depacketizer = new HevcDepacketizer();

      assert.deepStrictEqual(depacketizer.push(Buffer.from([0x00])), []);
      assert.deepStrictEqual(depacketizer.push(Buffer.alloc(0)), []);
    });
  });

  describe('hevcCodecStringFromSps', function () {
    it('derives the canonical codec string from the profile_tier_level', function () {
      // Main profile, compatibility flags 0x60000000 reversed to 6, main tier
      // ('L'), level 120 (4.0), constraint flags trimmed to '90'.
      assert.strictEqual(hevcCodecStringFromSps(SAMPLE_SPS), 'hev1.1.6.L120.90');
    });

    it('omits the profile-space character when the space is 0', function () {
      assert.match(hevcCodecStringFromSps(SAMPLE_SPS), /^hev1\.1\./);
    });

    it('marks the high tier with H', function () {
      const highTier = Buffer.from(SAMPLE_SPS_RBSP);
      highTier[1] |= 0x20; // set general_tier_flag

      const codec = hevcCodecStringFromSps(Buffer.concat([nalHeader(HevcNalType.SPS), escapeRbsp(highTier)]));

      assert.ok(codec.includes('.H120.'));
    });

    it('removes emulation-prevention bytes before parsing', function () {
      // The encoded NAL is longer than its RBSP precisely because of the
      // inserted 0x03 bytes; reading it without unescaping would misalign every
      // field after the first zero run.
      assert.ok(SAMPLE_SPS.length - 2 > SAMPLE_SPS_RBSP.length);
      assert.strictEqual(hevcCodecStringFromSps(SAMPLE_SPS), 'hev1.1.6.L120.90');
    });
  });

  describe('buildHevcDecoderConfigurationRecord', function () {
    const vps = makeNal(HevcNalType.VPS, Buffer.from('vps-body'));
    const pps = makeNal(HevcNalType.PPS, Buffer.from('pps-body'));

    it('produces a well-formed hvcC record', function () {
      const record = buildHevcDecoderConfigurationRecord(vps, SAMPLE_SPS, pps);

      assert.strictEqual(record[0], 1); // configurationVersion
      // lengthSizeMinusOne = 3 lives in the low 2 bits of byte 21.
      assert.strictEqual(record[21] & 0x03, 3);
      assert.strictEqual(record[22], 3); // numOfArrays: VPS, SPS, PPS
    });

    it('embeds all three parameter sets with their lengths', function () {
      const record = buildHevcDecoderConfigurationRecord(vps, SAMPLE_SPS, pps);

      let offset = 23;
      for (const [nalType, nal] of [
        [HevcNalType.VPS, vps],
        [HevcNalType.SPS, SAMPLE_SPS],
        [HevcNalType.PPS, pps],
      ] as const) {
        assert.strictEqual(record[offset], nalType);
        assert.strictEqual(record.readUInt16BE(offset + 1), 1); // numNalus
        assert.strictEqual(record.readUInt16BE(offset + 3), nal.length);
        assert.deepStrictEqual(record.subarray(offset + 5, offset + 5 + nal.length), nal);
        offset += 5 + nal.length;
      }
      assert.strictEqual(offset, record.length);
    });

    it('copies the SPS profile_tier_level verbatim', function () {
      const record = buildHevcDecoderConfigurationRecord(vps, SAMPLE_SPS, pps);

      // RBSP bytes 1..12 of the SPS land unchanged at record bytes 1..12 — and
      // must come from the *unescaped* RBSP, not the raw NAL payload.
      assert.deepStrictEqual(record.subarray(1, 13), SAMPLE_SPS_PTL);
    });

    it('rejects an SPS too short to hold a profile_tier_level', function () {
      assert.throws(() => buildHevcDecoderConfigurationRecord(vps, nalHeader(HevcNalType.SPS), pps), /too short/);
    });
  });

  describe('framing', function () {
    const first = makeNal(HevcNalType.VPS, Buffer.from('aa'));
    const second = makeNal(1, Buffer.from('bbbb'));

    it('prefixes each NAL with a 4-byte Annex-B start code', function () {
      const framed = toAnnexB([first, second]);

      assert.deepStrictEqual(framed.subarray(0, 4), Buffer.from([0, 0, 0, 1]));
      assert.strictEqual(framed.length, first.length + second.length + 8);
      assert.deepStrictEqual(framed.subarray(4, 4 + first.length), first);
      assert.deepStrictEqual(framed.subarray(8 + first.length), second);
    });

    it('prefixes each NAL with its big-endian length for hvcC framing', function () {
      const framed = toLengthPrefixed([first, second]);

      assert.strictEqual(framed.readUInt32BE(0), first.length);
      assert.strictEqual(framed.readUInt32BE(4 + first.length), second.length);
      assert.strictEqual(framed.length, first.length + second.length + 8);
    });

    it('returns an empty buffer for no NAL units', function () {
      assert.strictEqual(toAnnexB([]).length, 0);
      assert.strictEqual(toLengthPrefixed([]).length, 0);
    });
  });
});
