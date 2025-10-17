import { expect } from 'chai';

import {
  cstr,
  encodeHeader,
  parseCStringArray,
  parseKeyValueNullList,
  readUInt64LE,
  writeUInt64LE,
} from '../../../src/services/ios/afc/codec.js';
import {
  AFCMAGIC,
  AFC_FOPEN_TEXTUAL_MODES,
  AFC_HEADER_SIZE,
  AFC_WRITE_THIS_LENGTH,
} from '../../../src/services/ios/afc/constants.js';
import { AfcFopenMode } from '../../../src/services/ios/afc/enums.js';

describe('AFC Codec Utilities', function () {
  it('should expose correct header size and magic', function () {
    expect(AFC_HEADER_SIZE).to.equal(40);
    expect(AFCMAGIC.length).to.equal(8);
    expect(AFCMAGIC.toString('ascii')).to.equal('CFA6LPAA');
  });

  it('should write and read UInt64LE consistently', function () {
    const val = 0x1234567890abcdefn;
    const buf = writeUInt64LE(val);
    expect(buf.length).to.equal(8);
    const read = readUInt64LE(buf);
    expect(read).to.equal(val);
  });

  it('should encode header with proper lengths', function () {
    const op = 0x0fn; // arbitrary opcode
    const packetNum = 7n;
    const payloadLen = 100;
    const hdr = encodeHeader(Number(op), packetNum, payloadLen);
    expect(hdr.length).to.equal(AFC_HEADER_SIZE);

    // magic
    expect(hdr.subarray(0, 8).equals(AFCMAGIC)).to.be.true;

    // entire_length = header + payload
    const entire = readUInt64LE(hdr, 8);
    expect(Number(entire)).to.equal(AFC_HEADER_SIZE + payloadLen);

    // this_length defaults to entire_length
    const thisLen = readUInt64LE(hdr, 16);
    expect(Number(thisLen)).to.equal(AFC_HEADER_SIZE + payloadLen);

    // packet_num
    const pn = readUInt64LE(hdr, 24);
    expect(pn).to.equal(packetNum);

    // operation
    const opcode = readUInt64LE(hdr, 32);
    expect(Number(opcode)).to.equal(Number(op));
  });

  it('should support WRITE-specific this_length override', function () {
    const hdr = encodeHeader(0x10 /* WRITE */, 0n, 64, AFC_WRITE_THIS_LENGTH);
    const thisLen = readUInt64LE(hdr, 16);
    expect(Number(thisLen)).to.equal(AFC_WRITE_THIS_LENGTH);
  });

  it('should encode C-string with trailing null', function () {
    const buf = cstr('hello');
    expect(buf[buf.length - 1]).to.equal(0);
    expect(buf.subarray(0, buf.length - 1).toString('utf8')).to.equal('hello');
  });

  it('should parse CString array including empty terminator', function () {
    // "a\0b\0\0" => ['a', 'b', '']
    const buf = Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00]);
    const arr = parseCStringArray(buf);
    expect(arr).to.deep.equal(['a', 'b', '']);
  });

  it('should parse key/value null list with trailing empty', function () {
    // st_size\05\0st_ifmt\0S_IFREG\0\0
    const parts = [
      Buffer.from('st_size', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('5', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('st_ifmt', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('S_IFREG', 'utf8'),
      Buffer.from([0x00, 0x00]),
    ];
    const buf = Buffer.concat(parts);
    const kv = parseKeyValueNullList(buf);
    expect(kv).to.deep.equal({ st_size: '5', st_ifmt: 'S_IFREG' });
  });

  it('should map textual fopen modes correctly', function () {
    expect(AFC_FOPEN_TEXTUAL_MODES['r']).to.equal(AfcFopenMode.RDONLY);
    expect(AFC_FOPEN_TEXTUAL_MODES['r+']).to.equal(AfcFopenMode.RW);
    expect(AFC_FOPEN_TEXTUAL_MODES['w']).to.equal(AfcFopenMode.WRONLY);
    expect(AFC_FOPEN_TEXTUAL_MODES['w+']).to.equal(AfcFopenMode.WR);
    expect(AFC_FOPEN_TEXTUAL_MODES['a']).to.equal(AfcFopenMode.APPEND);
    expect(AFC_FOPEN_TEXTUAL_MODES['a+']).to.equal(AfcFopenMode.RDAPPEND);
  });
});
