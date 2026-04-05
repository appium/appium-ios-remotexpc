import { expect } from 'chai';

import { PlistUID, createBinaryPlist } from '../../src/lib/plist/index.js';
import {
  DTX_CONSTANTS,
  MessageAux,
} from '../../src/services/ios/dvt/dtx-message.js';
import {
  DvtTestmanagedProxyService,
  isExpectedCloseError,
  readPrimitiveDictEntry,
} from '../../src/services/ios/testmanagerd/index.js';
import { TestmanagerdEncoder } from '../../src/services/ios/testmanagerd/testmanagerd-encoder.js';
import { canonicalizeUuidString } from '../../src/services/ios/testmanagerd/uuid.js';
import { createNSUUID } from '../../src/services/ios/testmanagerd/xctestconfiguration.js';

/**
 * Testable subclass that exposes private methods for unit testing.
 */
class TestableDvtTestmanagedProxyService extends DvtTestmanagedProxyService {
  public testParseAuxiliaryData(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryData(buffer);
  }

  public testBuildAuxiliaryData(args: MessageAux): Buffer {
    return (this as any).buildAuxiliaryData(args);
  }

  public testParseAuxiliaryStandard(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryStandard(buffer);
  }

  public testParseAuxiliaryPrimitiveDictionary(buffer: Buffer): any[] {
    return (this as any).parseAuxiliaryPrimitiveDictionary(buffer);
  }
}

// #region Helpers

function buildStandardAuxBuffer(items: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(BigInt(DTX_CONSTANTS.MESSAGE_AUX_MAGIC), 0);
  header.writeBigUInt64LE(BigInt(items.length), 8);
  return Buffer.concat([header, items]);
}

function buildStandardItem(type: number, value: Buffer): Buffer {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
  const typeField = Buffer.alloc(4);
  typeField.writeUInt32LE(type, 0);
  return Buffer.concat([marker, typeField, value]);
}

function buildPrimitiveDictEntry(type: number, value: Buffer): Buffer {
  const key = Buffer.alloc(4);
  key.writeUInt32LE(DTX_CONSTANTS.EMPTY_DICTIONARY, 0);
  const typeField = Buffer.alloc(4);
  typeField.writeUInt32LE(type, 0);
  return Buffer.concat([key, typeField, value]);
}

// #endregion

describe('canonicalizeUuidString', function () {
  it('should normalize dashed, brace, and undashed forms', function () {
    const expected = 'aabbccdd-1122-3344-5566-778899aabbcc';
    expect(
      canonicalizeUuidString('AABBCCDD-1122-3344-5566-778899AABBCC'),
    ).to.equal(expected);
    expect(
      canonicalizeUuidString('{aabbccdd-1122-3344-5566-778899aabbcc}'),
    ).to.equal(expected);
    expect(canonicalizeUuidString('aabbccdd112233445566778899aabbcc')).to.equal(
      expected,
    );
  });

  it('should reject invalid input', function () {
    expect(() => canonicalizeUuidString('')).to.throw();
    expect(() => canonicalizeUuidString('not-a-uuid')).to.throw();
    expect(() =>
      canonicalizeUuidString('11111111-1111-1111-1111-111'),
    ).to.throw();
  });
});

describe('TestmanagerdEncoder', function () {
  let encoder: TestmanagerdEncoder;

  beforeEach(function () {
    encoder = new TestmanagerdEncoder();
  });

  it('should encode NSUUID with correct bytes and class', function () {
    const uuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
    const result = encoder.encode(createNSUUID(uuid));
    const objects = result.$objects;

    const nsUuidObj = objects.find(
      (o: any) => o && typeof o === 'object' && 'NS.uuidbytes' in o,
    );
    expect(nsUuidObj['NS.uuidbytes']).to.be.instanceOf(Buffer);
    expect(nsUuidObj['NS.uuidbytes'].length).to.equal(16);
    expect(
      nsUuidObj['NS.uuidbytes'].equals(
        Buffer.from(uuid.replace(/-/g, ''), 'hex'),
      ),
    ).to.be.true;

    const classObj = objects.find(
      (o: any) => o && typeof o === 'object' && o.$classname === 'NSUUID',
    );
    expect(classObj.$classes).to.deep.equal(['NSUUID', 'NSObject']);
  });

  it('should encode NSSet of NSUUID for _IDE_deleteAttachmentsWithUUIDs payload', function () {
    const uuids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ];
    const result = encoder.encode(new Set(uuids.map((u) => createNSUUID(u))));
    const objects = result.$objects as any[];
    const rootIdx = result.$top.root.value;
    const setObj = objects[rootIdx];
    expect(setObj['NS.objects']).to.have.length(2);
    const classDef = objects[setObj.$class.value];
    expect(classDef).to.have.property('$classname', 'NSSet');
    expect(classDef.$classes).to.deep.equal(['NSSet', 'NSObject']);

    const hexSorted = (buf: Buffer) => buf.toString('hex');
    const expectedHex = uuids
      .map((u) => hexSorted(Buffer.from(u.replace(/-/g, ''), 'hex')))
      .sort();
    const gotHex = setObj['NS.objects']
      .map((uid: PlistUID) =>
        hexSorted(objects[uid.value]['NS.uuidbytes'] as Buffer),
      )
      .sort();
    expect(gotHex).to.deep.equal(expectedHex);
    for (const uid of setObj['NS.objects'] as PlistUID[]) {
      const uuidClass = objects[objects[uid.value].$class.value];
      expect(uuidClass.$classname).to.equal('NSUUID');
    }
  });

  it('should encode XCTCapabilities with referenced dictionary', function () {
    const result = encoder.encode({
      __type: 'XCTCapabilities',
      capabilities: { cap1: 1, cap2: 2 },
    });
    const objects = result.$objects;

    const capObj = objects.find(
      (o: any) => o && typeof o === 'object' && 'capabilities-dictionary' in o,
    );
    expect(capObj).to.not.be.undefined;
    expect(capObj['capabilities-dictionary']).to.be.instanceOf(PlistUID);

    const dictObj = objects[capObj['capabilities-dictionary'].value];
    expect(dictObj['NS.keys']).to.have.length(2);
  });

  it('should encode empty/missing capabilities without error', function () {
    const empty = encoder.encode({
      __type: 'XCTCapabilities',
      capabilities: {},
    });
    const missing = new TestmanagerdEncoder().encode({
      __type: 'XCTCapabilities',
    });

    for (const result of [empty, missing]) {
      const capObj = result.$objects.find(
        (o: any) =>
          o && typeof o === 'object' && 'capabilities-dictionary' in o,
      );
      expect(capObj).to.not.be.undefined;
    }
  });
});

describe('isExpectedCloseError', function () {
  it('should return true for EPIPE and ECONNRESET codes', function () {
    expect(isExpectedCloseError(Object.assign(new Error(), { code: 'EPIPE' })))
      .to.be.true;
    expect(
      isExpectedCloseError(Object.assign(new Error(), { code: 'ECONNRESET' })),
    ).to.be.true;
  });

  it('should return true for expected close messages', function () {
    for (const msg of [
      'write after end',
      'Write After FIN',
      'Socket closed during read',
      'This socket has been ended by the other party',
    ]) {
      expect(isExpectedCloseError(new Error(msg))).to.be.true;
    }
  });

  it('should return false for non-matching inputs', function () {
    expect(isExpectedCloseError(null)).to.be.false;
    expect(isExpectedCloseError('string')).to.be.false;
    expect(
      isExpectedCloseError(Object.assign(new Error(), { code: 'ETIMEDOUT' })),
    ).to.be.false;
    expect(isExpectedCloseError(new Error('Something else'))).to.be.false;
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

  it('should parse string type', function () {
    const strBuf = Buffer.from('hello world', 'utf8');
    const buf = Buffer.alloc(4 + 4 + strBuf.length);
    buf.writeUInt32LE(DTX_CONSTANTS.PRIMITIVE_TYPE_STRING, 0);
    buf.writeUInt32LE(strBuf.length, 4);
    strBuf.copy(buf, 8);
    const result = readPrimitiveDictEntry(buf, 0);
    expect(result.data).to.equal('hello world');
  });

  it('should throw for unknown type', function () {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(0xff, 0);
    expect(() => readPrimitiveDictEntry(buf, 0)).to.throw(
      'Unknown PrimitiveDict type: 0xff',
    );
  });
});

describe('DvtTestmanagedProxyService auxiliary helpers', function () {
  let service: TestableDvtTestmanagedProxyService;

  beforeEach(function () {
    service = new TestableDvtTestmanagedProxyService(['::1', 0]);
  });

  describe('parseAuxiliaryData', function () {
    it('should route to standard parser when magic matches', function () {
      const val = Buffer.alloc(4);
      val.writeUInt32LE(7, 0);
      const item = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT32, val);
      const result = service.testParseAuxiliaryData(
        buildStandardAuxBuffer(item),
      );
      expect(result).to.deep.equal([7]);
    });

    it('should route to primitive dict parser for non-standard magic', function () {
      const fakeHeader = Buffer.alloc(16);
      fakeHeader.writeBigUInt64LE(BigInt(0xdeadbeef), 0);
      fakeHeader.writeBigUInt64LE(BigInt(100), 8);

      const entry = buildPrimitiveDictEntry(
        DTX_CONSTANTS.PRIMITIVE_TYPE_NULL,
        Buffer.alloc(0),
      );
      const result = service.testParseAuxiliaryData(
        Buffer.concat([fakeHeader, entry]),
      );
      expect(result).to.deep.equal([null]);
    });
  });

  describe('parseAuxiliaryStandard', function () {
    it('should parse multiple values of different types', function () {
      const int32Val = Buffer.alloc(4);
      int32Val.writeUInt32LE(1, 0);
      const item1 = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT32, int32Val);

      const int64Val = Buffer.alloc(8);
      int64Val.writeBigUInt64LE(BigInt(2), 0);
      const item2 = buildStandardItem(DTX_CONSTANTS.AUX_TYPE_INT64, int64Val);

      const result = service.testParseAuxiliaryStandard(
        buildStandardAuxBuffer(Buffer.concat([item1, item2])),
      );
      expect(result).to.deep.equal([1, BigInt(2)]);
    });

    it('should parse object values as binary plist', function () {
      const plistBuf = createBinaryPlist('hello');
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32LE(plistBuf.length, 0);
      const item = buildStandardItem(
        DTX_CONSTANTS.AUX_TYPE_OBJECT,
        Buffer.concat([lengthBuf, plistBuf]),
      );
      const result = service.testParseAuxiliaryStandard(
        buildStandardAuxBuffer(item),
      );
      expect(result).to.deep.equal(['hello']);
    });
  });

  describe('parseAuxiliaryPrimitiveDictionary', function () {
    it('should parse multiple entries', function () {
      const nullEntry = buildPrimitiveDictEntry(
        DTX_CONSTANTS.PRIMITIVE_TYPE_NULL,
        Buffer.alloc(0),
      );
      const uint32Val = Buffer.alloc(4);
      uint32Val.writeUInt32LE(77, 0);
      const uint32Entry = buildPrimitiveDictEntry(
        DTX_CONSTANTS.PRIMITIVE_TYPE_UINT32,
        uint32Val,
      );
      const result = service.testParseAuxiliaryPrimitiveDictionary(
        Buffer.concat([nullEntry, uint32Entry]),
      );
      expect(result).to.deep.equal([null, 77]);
    });

    it('should stop on unexpected key type', function () {
      const validEntry = buildPrimitiveDictEntry(
        DTX_CONSTANTS.PRIMITIVE_TYPE_NULL,
        Buffer.alloc(0),
      );
      const badKey = Buffer.alloc(4);
      badKey.writeUInt32LE(0xff, 0);
      const result = service.testParseAuxiliaryPrimitiveDictionary(
        Buffer.concat([validEntry, badKey]),
      );
      expect(result).to.deep.equal([null]);
    });
  });

  describe('buildAuxiliaryData round-trip', function () {
    it('should round-trip int32 and int64 values', function () {
      const args = new MessageAux();
      args.appendInt(99);
      args.appendLong(BigInt(123456789));
      args.appendInt(3);
      const built = service.testBuildAuxiliaryData(args);
      const parsed = service.testParseAuxiliaryStandard(built);
      expect(parsed).to.deep.equal([99, BigInt(123456789), 3]);
    });

    it('should round-trip object values as NSKeyedArchiver', function () {
      const args = new MessageAux();
      args.appendObj('hello');
      const built = service.testBuildAuxiliaryData(args);
      const parsed = service.testParseAuxiliaryStandard(built);
      expect(parsed).to.have.length(1);
      expect(parsed[0]).to.have.property('$archiver', 'NSKeyedArchiver');
    });
  });
});
