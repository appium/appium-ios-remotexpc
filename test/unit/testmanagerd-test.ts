import { expect } from 'chai';

import { PlistUID } from '../../src/lib/plist/index.js';
import { DTX_CONSTANTS } from '../../src/services/ios/dvt/dtx-message.js';
import {
  isExpectedCloseError,
  readPrimitiveDictEntry,
} from '../../src/services/ios/testmanagerd/index.js';
import { TestmanagerdEncoder } from '../../src/services/ios/testmanagerd/testmanagerd-encoder.js';

describe('TestmanagerdEncoder', function () {
  let encoder: TestmanagerdEncoder;

  beforeEach(function () {
    encoder = new TestmanagerdEncoder();
  });

  describe('NSUUID encoding', function () {
    it('should encode NSUUID marker to NSKeyedArchiver format', function () {
      const uuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const result = encoder.encode({ __type: 'NSUUID', uuid });

      const objects = result.$objects;
      const nsUuidObj = objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o,
      );
      expect(nsUuidObj).to.not.be.undefined;
      expect(nsUuidObj['NS.uuidbytes']).to.be.instanceOf(Buffer);
      expect(nsUuidObj['NS.uuidbytes'].length).to.equal(16);

      const expectedBytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
      expect(nsUuidObj['NS.uuidbytes'].equals(expectedBytes)).to.be.true;

      const classObj = objects.find(
        (o: any) => o && typeof o === 'object' && o.$classname === 'NSUUID',
      );
      expect(classObj).to.not.be.undefined;
      expect(classObj.$classes).to.deep.equal(['NSUUID', 'NSObject']);
    });

    it('should produce 16-byte buffer for zero UUID', function () {
      const result = encoder.encode({
        __type: 'NSUUID',
        uuid: '00000000-0000-0000-0000-000000000000',
      });
      const nsUuidObj = result.$objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o,
      );
      expect(nsUuidObj['NS.uuidbytes']).to.deep.equal(Buffer.alloc(16));
    });
  });

  describe('XCTCapabilities encoding', function () {
    it('should encode XCTCapabilities with capabilities dictionary', function () {
      const caps = { 'test capability': 1, 'another capability': 2 };
      const result = encoder.encode({
        __type: 'XCTCapabilities',
        capabilities: caps,
      });

      const objects = result.$objects;

      const classObj = objects.find(
        (o: any) =>
          o && typeof o === 'object' && o.$classname === 'XCTCapabilities',
      );
      expect(classObj).to.not.be.undefined;

      const capObj = objects.find(
        (o: any) =>
          o && typeof o === 'object' && 'capabilities-dictionary' in o,
      );
      expect(capObj).to.not.be.undefined;
      expect(capObj['capabilities-dictionary']).to.be.instanceOf(PlistUID);

      // The referenced dict should contain our capability keys
      const dictIndex = capObj['capabilities-dictionary'].value;
      const dictObj = objects[dictIndex];
      expect(dictObj).to.have.property('NS.keys');
      expect(dictObj).to.have.property('NS.objects');
      // 2 keys
      expect(dictObj['NS.keys']).to.have.length(2);
    });

    it('should encode empty capabilities', function () {
      const result = encoder.encode({
        __type: 'XCTCapabilities',
        capabilities: {},
      });
      const capObj = result.$objects.find(
        (o: any) =>
          o && typeof o === 'object' && 'capabilities-dictionary' in o,
      );
      expect(capObj).to.not.be.undefined;
      const dictIndex = capObj['capabilities-dictionary'].value;
      const dictObj = result.$objects[dictIndex];
      expect(dictObj['NS.keys']).to.have.length(0);
    });

    it('should default to empty dict when capabilities field is missing', function () {
      const result = encoder.encode({ __type: 'XCTCapabilities' });
      const capObj = result.$objects.find(
        (o: any) =>
          o && typeof o === 'object' && 'capabilities-dictionary' in o,
      );
      expect(capObj).to.not.be.undefined;
    });
  });

  describe('fallthrough to base encoder', function () {
    it('should encode plain strings normally', function () {
      const result = encoder.encode('hello');
      expect(result.$objects).to.include('hello');
    });

    it('should encode plain dictionaries normally', function () {
      const result = encoder.encode({ key: 'value' });
      const dictObj = result.$objects.find(
        (o: any) => o && typeof o === 'object' && 'NS.keys' in o,
      );
      expect(dictObj).to.not.be.undefined;
    });
  });
});

describe('isExpectedCloseError', function () {
  it('should return false for null/undefined/non-objects', function () {
    expect(isExpectedCloseError(null)).to.be.false;
    expect(isExpectedCloseError(undefined)).to.be.false;
    expect(isExpectedCloseError('string')).to.be.false;
    expect(isExpectedCloseError(42)).to.be.false;
  });

  it('should return true for EPIPE error code', function () {
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isExpectedCloseError(err)).to.be.true;
  });

  it('should return true for ECONNRESET error code', function () {
    const err = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    expect(isExpectedCloseError(err)).to.be.true;
  });

  it('should return false for unrelated error codes', function () {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isExpectedCloseError(err)).to.be.false;
  });

  it('should match "write after end" message', function () {
    expect(isExpectedCloseError(new Error('write after end'))).to.be.true;
  });

  it('should match "write after fin" message', function () {
    expect(isExpectedCloseError(new Error('Write After FIN'))).to.be.true;
  });

  it('should match "socket closed" message', function () {
    expect(isExpectedCloseError(new Error('Socket closed during read'))).to.be
      .true;
  });

  it('should match "socket has been ended by the other party" message', function () {
    expect(
      isExpectedCloseError(
        new Error('This socket has been ended by the other party'),
      ),
    ).to.be.true;
  });

  it('should return false for unrelated error messages', function () {
    expect(isExpectedCloseError(new Error('Something went wrong'))).to.be.false;
  });
});

describe('readPrimitiveDictEntry', function () {
  it('should parse null type', function () {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_NULL, 0);
    const result = readPrimitiveDictEntry(buf, 0);
    expect(result.data).to.be.null;
    expect(result.newOffset).to.equal(4);
  });

  it('should parse uint32 type', function () {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_UINT32, 0);
    buf.writeUInt32LE(42, 4);
    const result = readPrimitiveDictEntry(buf, 0);
    expect(result.data).to.equal(42);
    expect(result.newOffset).to.equal(8);
  });

  it('should parse int64 type', function () {
    const buf = Buffer.alloc(12);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_INT64, 0);
    buf.writeBigUInt64LE(BigInt(123456789), 4);
    const result = readPrimitiveDictEntry(buf, 0);
    expect(result.data).to.equal(123456789);
    expect(result.newOffset).to.equal(12);
  });

  it('should parse string type', function () {
    const str = 'hello world';
    const strBuf = Buffer.from(str, 'utf8');
    const buf = Buffer.alloc(4 + 4 + strBuf.length);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_STRING, 0);
    buf.writeUInt32LE(strBuf.length, 4);
    strBuf.copy(buf, 8);
    const result = readPrimitiveDictEntry(buf, 0);
    expect(result.data).to.equal('hello world');
    expect(result.newOffset).to.equal(8 + strBuf.length);
  });

  it('should parse bytearray type with non-plist data as raw buffer', function () {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const buf = Buffer.alloc(4 + 4 + payload.length);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_BYTEARRAY, 0);
    buf.writeUInt32LE(payload.length, 4);
    payload.copy(buf, 8);
    const result = readPrimitiveDictEntry(buf, 0);
    // Non-plist bytearray returns raw buffer
    expect(Buffer.isBuffer(result.data)).to.be.true;
    expect(result.data).to.deep.equal(payload);
  });

  it('should respect non-zero offset', function () {
    const prefix = Buffer.from([0xff, 0xff]); // 2 bytes of junk
    const buf = Buffer.alloc(2 + 8);
    prefix.copy(buf, 0);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_UINT32, 2);
    buf.writeUInt32LE(99, 6);
    const result = readPrimitiveDictEntry(buf, 2);
    expect(result.data).to.equal(99);
    expect(result.newOffset).to.equal(10);
  });

  it('should throw for unknown type', function () {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(0xff, 0);
    expect(() => readPrimitiveDictEntry(buf, 0)).to.throw(
      'Unknown PrimitiveDict type: 0xff',
    );
  });
});
