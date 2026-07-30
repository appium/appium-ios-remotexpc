import {describe, it} from 'node:test';

import {expect} from 'chai';

import {AccessUnitAssembler} from '../../../src/services/ios/display/access-unit-assembler.js';
import {HevcNalType} from '../../../src/services/ios/display/hevc.js';
import type {RtpPacket} from '../../../src/services/ios/display/rtp.js';

function nalHeader(nalType: number): Buffer {
  return Buffer.from([(nalType << 1) & 0x7e, 0x01]);
}

function makeNal(nalType: number, payload: Buffer): Buffer {
  return Buffer.concat([nalHeader(nalType), payload]);
}

/** Builds a single-NAL RTP packet carrying `nal`. */
function packet(nal: Buffer, options: Partial<RtpPacket> = {}): RtpPacket {
  return {
    payloadType: 123,
    marker: false,
    sequence: 0,
    timestamp: 1000,
    ssrc: 1,
    payload: nal,
    ...options,
  };
}

/** Wraps `data` in an RFC 7798 fragmentation unit payload. */
function fu(originalNalType: number, data: Buffer, start: boolean, end: boolean): Buffer {
  const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | originalNalType;
  return Buffer.concat([nalHeader(HevcNalType.FU), Buffer.from([fuHeader]), data]);
}

const VPS = makeNal(HevcNalType.VPS, Buffer.from('vps'));
const PPS = makeNal(HevcNalType.PPS, Buffer.from('pps'));
const IDR = makeNal(HevcNalType.IDR_W_RADL, Buffer.from('keyframe-slice'));
const DELTA = makeNal(1, Buffer.from('delta-slice'));

/** A valid Main/L4.0 SPS; see hevc.spec.ts for the field breakdown. */
const SPS_RBSP = Buffer.from([0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x78]);
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
const SPS = Buffer.concat([nalHeader(HevcNalType.SPS), escapeRbsp(SPS_RBSP)]);

describe('AccessUnitAssembler', function () {
  it('emits an access unit on the marker bit', function () {
    const assembler = new AccessUnitAssembler();

    expect(assembler.push(packet(VPS, {sequence: 1}))).to.equal(undefined);
    expect(assembler.push(packet(SPS, {sequence: 2}))).to.equal(undefined);
    expect(assembler.push(packet(PPS, {sequence: 3}))).to.equal(undefined);
    const unit = assembler.push(packet(IDR, {sequence: 4, marker: true}));

    expect(unit).to.not.equal(undefined);
    expect(unit?.nals).to.deep.equal([VPS, SPS, PPS, IDR]);
    expect(unit?.isKeyFrame).to.equal(true);
    expect(unit?.timestamp).to.equal(1000);
  });

  it('marks delta-only access units as non-key', function () {
    const assembler = new AccessUnitAssembler();

    const unit = assembler.push(packet(DELTA, {sequence: 1, marker: true}));

    expect(unit?.isKeyFrame).to.equal(false);
  });

  it('separates consecutive pictures', function () {
    const assembler = new AccessUnitAssembler();

    const first = assembler.push(packet(IDR, {sequence: 1, marker: true, timestamp: 100}));
    const second = assembler.push(packet(DELTA, {sequence: 2, marker: true, timestamp: 200}));

    expect(first?.nals).to.deep.equal([IDR]);
    expect(second?.nals).to.deep.equal([DELTA]);
    expect(second?.timestamp).to.equal(200);
    expect(assembler.stats.accessUnitsEmitted).to.equal(2);
  });

  it('reassembles a picture split across fragmentation units', function () {
    const assembler = new AccessUnitAssembler();
    const body = Buffer.from('a-long-keyframe-slice');

    assembler.push(packet(fu(HevcNalType.IDR_W_RADL, body.subarray(0, 8), true, false), {sequence: 1}));
    assembler.push(packet(fu(HevcNalType.IDR_W_RADL, body.subarray(8), false, true), {sequence: 2}));
    const unit = assembler.push(packet(DELTA, {sequence: 3, marker: true}));

    expect(unit?.isKeyFrame).to.equal(true);
    expect(unit?.nals[0].subarray(2)).to.deep.equal(body);
  });

  it('drops the access unit when a packet is lost', function () {
    const assembler = new AccessUnitAssembler();

    assembler.push(packet(VPS, {sequence: 1}));
    // Sequence jumps 2 → 5: three packets vanished mid-picture.
    const unit = assembler.push(packet(IDR, {sequence: 5, marker: true}));

    expect(unit).to.equal(undefined);
    expect(assembler.stats.packetsLost).to.equal(3);
    expect(assembler.stats.accessUnitsDropped).to.equal(1);
    expect(assembler.stats.accessUnitsEmitted).to.equal(0);
  });

  it('recovers on the next intact access unit after a loss', function () {
    const assembler = new AccessUnitAssembler();

    assembler.push(packet(VPS, {sequence: 1}));
    expect(assembler.push(packet(IDR, {sequence: 5, marker: true}))).to.equal(undefined);
    const recovered = assembler.push(packet(IDR, {sequence: 6, marker: true}));

    expect(recovered).to.not.equal(undefined);
    expect(assembler.stats.accessUnitsEmitted).to.equal(1);
  });

  it('does not count a wrapped sequence number as a loss', function () {
    const assembler = new AccessUnitAssembler();

    assembler.push(packet(VPS, {sequence: 0xffff}));
    const unit = assembler.push(packet(IDR, {sequence: 0, marker: true}));

    expect(unit).to.not.equal(undefined);
    expect(assembler.stats.packetsLost).to.equal(0);
  });

  it('caches parameter sets and derives the codec string', function () {
    const assembler = new AccessUnitAssembler();

    expect(assembler.parameterSets).to.equal(undefined);
    assembler.push(packet(VPS, {sequence: 1}));
    assembler.push(packet(SPS, {sequence: 2}));
    expect(assembler.codecString).to.equal('hev1.1.6.L120.90');
    // Still incomplete until the PPS lands.
    expect(assembler.parameterSets).to.equal(undefined);
    assembler.push(packet(PPS, {sequence: 3}));

    expect(assembler.parameterSets).to.deep.equal({vps: VPS, sps: SPS, pps: PPS});
    expect(assembler.decoderConfigurationRecord).to.be.instanceOf(Buffer);
  });

  it('has no decoder configuration record until every set has arrived', function () {
    const assembler = new AccessUnitAssembler();
    assembler.push(packet(SPS, {sequence: 1}));

    expect(assembler.decoderConfigurationRecord).to.equal(undefined);
  });

  it('counts every packet it is fed', function () {
    const assembler = new AccessUnitAssembler();

    assembler.push(packet(VPS, {sequence: 1}));
    assembler.push(packet(IDR, {sequence: 2, marker: true}));

    expect(assembler.stats.packetsReceived).to.equal(2);
  });
});
