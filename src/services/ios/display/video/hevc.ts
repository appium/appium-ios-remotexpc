/**
 * HEVC (H.265) helpers for the DisplayService screen stream: RFC 7798 RTP
 * depacketization, parameter-set parsing, and the container framings a decoder
 * needs.
 */

/** HEVC NAL unit types used by this module (ISO/IEC 23008-2 Table 7-1). */
export const HevcNalType = {
  /** IDR with leading pictures. */
  IDR_W_RADL: 19,
  /** IDR without leading pictures. */
  IDR_N_LP: 20,
  /** Clean random access. */
  CRA: 21,
  /** Video parameter set. */
  VPS: 32,
  /** Sequence parameter set. */
  SPS: 33,
  /** Picture parameter set. */
  PPS: 34,
  /** RFC 7798 aggregation packet. */
  AP: 48,
  /** RFC 7798 fragmentation unit. */
  FU: 49,
} as const;

/** Returns whether `nalType` starts a new independently decodable picture. */
export function isKeyNalType(nalType: number): boolean {
  return nalType === HevcNalType.IDR_W_RADL || nalType === HevcNalType.IDR_N_LP || nalType === HevcNalType.CRA;
}

/** Reads the 6-bit NAL unit type out of a NAL's two-byte header. */
export function nalTypeOf(nal: Buffer): number {
  return (nal[0] >> 1) & 0x3f;
}

/**
 * Apple's DisplayService appends this fixed 14-byte proprietary footer after
 * the final fragment of each coded-slice NAL. It is not part of the HEVC
 * bitstream — `avconferenced` (the receiver Xcode uses) strips it before
 * decode, whereas plain RFC 7798 reassembly would hand it to the decoder as
 * trailing slice data. Matched as an exact suffix, so this is a no-op on
 * streams that do not carry it.
 */
const DISPLAY_SERVICE_NAL_TRAILER = Buffer.from('04f00ac0000003000004ec0ab003', 'hex');

function stripDisplayServiceTrailer(nal: Buffer): Buffer {
  const start = nal.length - DISPLAY_SERVICE_NAL_TRAILER.length;
  if (start > 0 && nal.subarray(start).equals(DISPLAY_SERVICE_NAL_TRAILER)) {
    return nal.subarray(0, start);
  }
  return nal;
}

/**
 * Reassembles HEVC NAL units from RTP payloads (RFC 7798).
 *
 * Handles the three payload structures the device emits: single NAL units,
 * aggregation packets (AP) and fragmentation units (FU). Fragmentation state
 * spans packets, so one instance must be used for the lifetime of a stream —
 * and {@link reset} must be called whenever an RTP sequence gap is detected, so
 * non-contiguous fragments are never stitched into one NAL.
 */
export class HevcDepacketizer {
  private fuBuffer: Buffer[] = [];
  private fuActive = false;

  /**
   * Feeds one RTP payload and returns whatever complete NAL units it produced
   * (usually zero or one; an aggregation packet can yield several).
   */
  push(payload: Buffer): Buffer[] {
    if (payload.length < 2) {
      return [];
    }
    const nalType = nalTypeOf(payload);
    if (nalType === HevcNalType.AP) {
      return this.pushAggregationPacket(payload);
    }
    if (nalType === HevcNalType.FU) {
      return this.pushFragmentationUnit(payload);
    }
    return [stripDisplayServiceTrailer(payload)];
  }

  /**
   * Discards any partially reassembled NAL. Call on an RTP sequence gap: the
   * missing fragment means the rest can no longer form a valid NAL.
   */
  reset(): void {
    this.fuBuffer = [];
    this.fuActive = false;
  }

  private pushAggregationPacket(payload: Buffer): Buffer[] {
    const nals: Buffer[] = [];
    // Skip the 2-byte PayloadHdr, then walk [16-bit size][NAL] pairs.
    let offset = 2;
    while (offset + 2 <= payload.length) {
      const size = payload.readUInt16BE(offset);
      offset += 2;
      // A truncated trailing entry means the packet is malformed; take what fits.
      const end = Math.min(offset + size, payload.length);
      nals.push(payload.subarray(offset, end));
      offset = end;
    }
    return nals;
  }

  private pushFragmentationUnit(payload: Buffer): Buffer[] {
    if (payload.length < 3) {
      return [];
    }
    const fuHeader = payload[2];
    const isStart = (fuHeader & 0x80) !== 0;
    const isEnd = (fuHeader & 0x40) !== 0;
    const originalNalType = fuHeader & 0x3f;

    if (isStart) {
      // Rebuild the original 2-byte NAL header: keep the forbidden-zero bit and
      // the low layer-id bit from the payload header, splice the real type in.
      const byte0 = (payload[0] & 0x81) | (originalNalType << 1);
      this.fuBuffer = [Buffer.from([byte0, payload[1]]), payload.subarray(3)];
      this.fuActive = true;
    } else {
      if (!this.fuActive) {
        // Continuation without a start (we joined mid-NAL, or the start was
        // lost): there is no valid header to prepend, so drop it.
        return [];
      }
      this.fuBuffer.push(payload.subarray(3));
    }

    if (isEnd && this.fuActive) {
      const nal = Buffer.concat(this.fuBuffer);
      this.reset();
      return nal.length > 0 ? [stripDisplayServiceTrailer(nal)] : [];
    }
    return [];
  }
}

/**
 * Strips a NAL's 2-byte header and its emulation-prevention bytes
 * (`00 00 03` → `00 00`), yielding the raw RBSP.
 */
function hevcRbsp(nal: Buffer): Buffer {
  const out: number[] = [];
  let i = 2;
  while (i < nal.length) {
    if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
      out.push(nal[i], nal[i + 1]);
      i += 3;
    } else {
      out.push(nal[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

/**
 * Sequential bit reader over an RBSP.
 *
 * Values are accumulated with multiplication rather than `<<`, because JS
 * bitwise operators truncate to 32 bits and the profile/constraint fields read
 * here are 32 and 48 bits wide.
 */
function createBitReader(data: Buffer): (count: number) => number {
  let position = 0;
  return (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = data[position >> 3];
      if (byte === undefined) {
        throw new RangeError('Ran past the end of the bitstream');
      }
      value = value * 2 + ((byte >> (7 - (position & 7))) & 1);
      position += 1;
    }
    return value;
  };
}

/** Reverses the low 32 bits of `value` (arithmetic, to stay 32-bit safe). */
function reverse32(value: number): number {
  let reversed = 0;
  let remaining = value;
  for (let i = 0; i < 32; i++) {
    reversed = reversed * 2 + (remaining % 2);
    remaining = Math.floor(remaining / 2);
  }
  return reversed;
}

/**
 * Parses an HEVC SPS NAL and returns the codec string used by WebCodecs and
 * `<video>` MIME types, per ISO/IEC 14496-15 §A.3.3.1:
 * `hev1.<profile_space><profile_idc>.<reversed_pcf>.<tier><level>.<constraints>`.
 *
 * @param spsNal The full SPS NAL unit, including its 2-byte header.
 */
export function hevcCodecStringFromSps(spsNal: Buffer): string {
  const rbsp = hevcRbsp(spsNal);
  const readBits = createBitReader(rbsp);

  readBits(4); // sps_video_parameter_set_id
  readBits(3); // sps_max_sub_layers_minus1
  readBits(1); // sps_temporal_id_nesting_flag
  const profileSpace = readBits(2);
  const tierFlag = readBits(1);
  const profileIdc = readBits(5);
  const profileCompatibilityFlags = readBits(32);
  const constraintIndicatorFlags = readBits(48);
  const levelIdc = readBits(8);

  // Per §A.3.3.1 general_profile_space 0 contributes no character, and 1/2/3
  // map to 'A'/'B'/'C'. (Real-world screen streams always use 0.)
  const profileSpaceChar = profileSpace ? 'ABC'[profileSpace - 1] : '';
  const tierChar = tierFlag ? 'H' : 'L';
  const reversedPcf = reverse32(profileCompatibilityFlags).toString(16).toUpperCase();

  let constraintHex = constraintIndicatorFlags.toString(16).toUpperCase().padStart(12, '0');
  while (constraintHex.length > 2 && constraintHex.endsWith('00')) {
    constraintHex = constraintHex.slice(0, -2);
  }

  return `hev1.${profileSpaceChar}${profileIdc}.${reversedPcf}.${tierChar}${levelIdc}.${constraintHex}`;
}

/**
 * Builds an ISO/IEC 14496-15 §8.3.3.1 `HEVCDecoderConfigurationRecord` (hvcC).
 *
 * This is the out-of-band `description` for hvcC-mode decoding, where NAL units
 * are 4-byte length-prefixed and parameter sets are supplied separately —
 * as opposed to the Annex-B start-code path.
 *
 * The 12-byte `profile_tier_level` occupies RBSP bytes 1..12 of the SPS with
 * exactly the layout hvcC wants, so it is copied verbatim rather than re-parsed.
 */
export function buildHevcDecoderConfigurationRecord(vps: Buffer, sps: Buffer, pps: Buffer): Buffer {
  const ptl = hevcRbsp(sps).subarray(1, 13);
  if (ptl.length !== 12) {
    throw new Error('SPS is too short to contain a profile_tier_level');
  }

  const header = Buffer.concat([
    Buffer.from([1]), // configurationVersion
    Buffer.from([ptl[0]]), // profile_space(2) | tier_flag(1) | profile_idc(5)
    ptl.subarray(1, 5), // general_profile_compatibility_flags (32b)
    ptl.subarray(5, 11), // general_constraint_indicator_flags (48b)
    Buffer.from([ptl[11]]), // general_level_idc
    Buffer.from([0xf0, 0x00]), // reserved(4)=1111 | min_spatial_segmentation_idc=0
    Buffer.from([0xfc]), // reserved(6)=1 | parallelismType=0
    Buffer.from([0xfc | 0x01]), // reserved(6)=1 | chroma_format_idc=1 (4:2:0)
    Buffer.from([0xf8]), // reserved(5)=1 | bit_depth_luma_minus8=0
    Buffer.from([0xf8]), // reserved(5)=1 | bit_depth_chroma_minus8=0
    Buffer.from([0x00, 0x00]), // avgFrameRate=0 (unspecified)
    // constantFrameRate(2)=0 | numTemporalLayers(3)=1 | temporalIdNested(1)=0 | lengthSizeMinusOne(2)=3
    Buffer.from([(0 << 6) | (1 << 3) | (0 << 2) | 0x03]),
    Buffer.from([3]), // numOfArrays: VPS, SPS, PPS
  ]);

  const arrays = (
    [
      [HevcNalType.VPS, vps],
      [HevcNalType.SPS, sps],
      [HevcNalType.PPS, pps],
    ] as const
  ).map(([nalType, nal]) => {
    const entry = Buffer.alloc(5);
    // array_completeness(1)=0 | reserved(1)=0 | NAL_unit_type(6); hev1 allows in-band sets.
    entry.writeUInt8(nalType, 0);
    entry.writeUInt16BE(1, 1); // numNalus
    entry.writeUInt16BE(nal.length, 3); // nalUnitLength
    return Buffer.concat([entry, nal]);
  });

  return Buffer.concat([header, ...arrays]);
}

const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

/**
 * Frames NAL units as an Annex-B elementary stream (4-byte start codes) — the
 * layout `.h265`/`.hevc` files use and what ffmpeg, VLC and MediaPipeline
 * demuxers expect.
 */
export function toAnnexB(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const nal of nals) {
    parts.push(ANNEX_B_START_CODE, nal);
  }
  return Buffer.concat(parts);
}

/**
 * Frames NAL units with 4-byte big-endian length prefixes — the hvcC / ISO
 * 14496-15 sample format (`lengthSizeMinusOne = 3`) that pairs with the record
 * from {@link buildHevcDecoderConfigurationRecord}.
 */
export function toLengthPrefixed(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const nal of nals) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(nal.length, 0);
    parts.push(prefix, nal);
  }
  return Buffer.concat(parts);
}
