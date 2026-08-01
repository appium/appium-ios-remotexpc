import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  cstr,
  encodeHeader,
  encodeHeaderExplicit,
  nanosecondsToMilliseconds,
  parseCStringArray,
  parseKeyValueNullList,
  readUInt64LE,
  writeUInt64LE,
} from '../../../src/services/ios/afc/codec.js';
import {AFCMAGIC, AFC_FOPEN_TEXTUAL_MODES, AFC_HEADER_SIZE} from '../../../src/services/ios/afc/constants.js';
import {AfcFopenMode} from '../../../src/services/ios/afc/enums.js';

describe('AFC Codec Utilities', function () {
  it('should expose correct header size and magic', function () {
    assert.strictEqual(AFC_HEADER_SIZE, 40);
    assert.strictEqual(AFCMAGIC.length, 8);
    assert.strictEqual(AFCMAGIC.toString('ascii'), 'CFA6LPAA');
  });

  it('should write and read UInt64LE consistently', function () {
    const val = 0x1234567890abcdefn;
    const buf = writeUInt64LE(val);
    assert.strictEqual(buf.length, 8);
    const read = readUInt64LE(buf);
    assert.strictEqual(read, val);
  });

  it('should encode header with proper lengths', function () {
    const op = 0x0fn; // arbitrary opcode
    const packetNum = 7n;
    const payloadLen = 100;
    const hdr = encodeHeader(Number(op), packetNum, payloadLen);
    assert.strictEqual(hdr.length, AFC_HEADER_SIZE);

    // magic
    assert.strictEqual(hdr.subarray(0, 8).equals(AFCMAGIC), true);

    // entire_length = header + payload
    const entire = readUInt64LE(hdr, 8);
    assert.strictEqual(Number(entire), AFC_HEADER_SIZE + payloadLen);

    // this_length defaults to entire_length
    const thisLen = readUInt64LE(hdr, 16);
    assert.strictEqual(Number(thisLen), AFC_HEADER_SIZE + payloadLen);

    // packet_num
    const pn = readUInt64LE(hdr, 24);
    assert.strictEqual(pn, packetNum);

    // operation
    const opcode = readUInt64LE(hdr, 32);
    assert.strictEqual(Number(opcode), Number(op));
  });

  it('should support WRITE-specific this_length for split payloads', function () {
    const handleLen = 8;
    const contentLen = 64;
    const thisLen = AFC_HEADER_SIZE + handleLen;
    const entireLen = thisLen + contentLen;
    const hdr = encodeHeaderExplicit(0x10 /* WRITE */, 0n, entireLen, thisLen);
    assert.strictEqual(Number(readUInt64LE(hdr, 8)), entireLen);
    assert.strictEqual(Number(readUInt64LE(hdr, 16)), thisLen);
  });

  it('should encode C-string with trailing null', function () {
    const buf = cstr('hello');
    assert.strictEqual(buf[buf.length - 1], 0);
    assert.strictEqual(buf.subarray(0, buf.length - 1).toString('utf8'), 'hello');
  });

  it('should parse CString array without trailing empty terminator', function () {
    // "a\0b\0\0" => ['a', 'b']
    const buf = Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00]);
    const arr = parseCStringArray(buf);
    assert.deepStrictEqual(arr, ['a', 'b']);
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
    assert.deepStrictEqual(kv, {st_size: '5', st_ifmt: 'S_IFREG'});
  });

  it('should map textual fopen modes correctly', function () {
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES.r, AfcFopenMode.RDONLY);
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES['r+'], AfcFopenMode.RW);
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES.w, AfcFopenMode.WRONLY);
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES['w+'], AfcFopenMode.WR);
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES.a, AfcFopenMode.APPEND);
    assert.strictEqual(AFC_FOPEN_TEXTUAL_MODES['a+'], AfcFopenMode.RDAPPEND);
  });

  it('should convert nanoseconds to milliseconds without overflow', function () {
    const ns = '1729866045000000000';
    const ms = nanosecondsToMilliseconds(ns);
    assert.strictEqual(ms, 1729866045000);
  });
});
