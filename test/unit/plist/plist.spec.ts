import assert from 'node:assert/strict';
import path from 'node:path';
import {before, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {fs, node} from '@appium/support';

import {
  createBinaryPlist,
  createPlist,
  createXmlPlist,
  isBinaryPlist,
  parseBinaryPlist,
  parsePlist,
  parseXmlPlist,
} from '../../../src/lib/plist/index.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

const PKG_ROOT = node.getModuleRootSync('appium-ios-remotexpc', fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(PKG_ROOT, 'test', 'unit', 'plist', 'fixtures');

const BPLIST_TRAILER_LENGTH = 32;

/**
 * String lengths that make the encoded object data straddle the 256 byte mark, where
 * the offset table starts past what a single byte offset can address.
 */
const OFFSET_TABLE_BOUNDARY_LENGTHS = Array.from({length: 101}, (_, index) => 200 + index);

/**
 * Reads the trailer fields CoreFoundation validates before parsing a binary plist.
 */
function readBinaryPlistTrailer(binaryPlist: Buffer): {
  offsetIntSize: number;
  objectRefSize: number;
  numObjects: number;
  offsetTableOffset: number;
} {
  const trailer = binaryPlist.subarray(binaryPlist.length - BPLIST_TRAILER_LENGTH);
  return {
    offsetIntSize: trailer.readUInt8(6),
    objectRefSize: trailer.readUInt8(7),
    numObjects: Number(trailer.readBigUInt64BE(8)),
    offsetTableOffset: Number(trailer.readBigUInt64BE(24)),
  };
}

describe('Plist Module', function () {
  let sampleXmlPlistPath: string;
  let sampleXmlPlistContent: string;
  let sampleBinaryPlistPath: string;
  let sampleBinaryPlistContent: Buffer;
  let expectedPlistObject: PlistDictionary;

  before(async function () {
    sampleXmlPlistPath = path.join(FIXTURES_PATH, 'sample.xml.plist');
    sampleXmlPlistContent = await fs.readFile(sampleXmlPlistPath, 'utf8');

    sampleBinaryPlistPath = path.join(FIXTURES_PATH, 'sample.binary.plist');
    sampleBinaryPlistContent = await fs.readFile(sampleBinaryPlistPath);

    // Define the expected object structure that should match our XML plist
    expectedPlistObject = {
      stringValue: 'Hello, World!',
      integerValue: 42,
      realValue: 3.14159,
      booleanTrue: true,
      booleanFalse: false,
      dateValue: new Date('2023-01-01T12:00:00Z'),
      dataValue: Buffer.from('Hello, World!'),
      arrayValue: ['Item 1', 'Item 2', 3],
      dictValue: {
        nestedKey: 'Nested Value',
        nestedArray: [1, 2],
      },
      specialChars: '<Hello & World>',
      emoji: '😀',
      unicode: '测试',
    };
  });

  describe('XML Plist Functions', function () {
    it('should parse XML plists correctly', function () {
      const result = parseXmlPlist(sampleXmlPlistContent);

      // Basic types
      assert.ok(typeof result === 'object' && result !== null && !Array.isArray(result));
      assert.strictEqual(result.stringValue, 'Hello, World!');
      assert.strictEqual(result.integerValue, 42);
      assert.ok(Math.abs((result.realValue as number) - 3.14159) <= 0.00001);
      assert.strictEqual(result.booleanTrue, true);
      assert.strictEqual(result.booleanFalse, false);

      // Complex types
      assert.ok(Array.isArray(result.arrayValue));
      assert.strictEqual(result.arrayValue.length, 3);
      assert.ok(typeof result.dictValue === 'object' && result.dictValue !== null && !Array.isArray(result.dictValue));
      assert.strictEqual(result.specialChars, '<Hello & World>');

      // Error handling
      assert.throws(() => parseXmlPlist('not a valid xml'));
    });

    it('should create XML plists correctly', function () {
      const xmlContent = createXmlPlist(expectedPlistObject);

      // Check structure
      assert.ok(xmlContent.includes('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.ok(xmlContent.includes('<!DOCTYPE plist'));
      assert.ok(xmlContent.includes('<plist version="1.0">'));

      // Check content
      assert.ok(xmlContent.includes('<key>stringValue</key>'));
      assert.ok(xmlContent.includes('<string>Hello, World!</string>'));
      assert.ok(xmlContent.includes('<key>integerValue</key>'));
      assert.ok(xmlContent.includes('<integer>42</integer>'));
      assert.ok(xmlContent.includes('&lt;Hello &amp; World&gt;'));

      // Round-trip test
      const parsedBack = parseXmlPlist(xmlContent);
      assert.strictEqual(parsedBack.stringValue, 'Hello, World!');
      assert.strictEqual(parsedBack.integerValue, 42);
    });
  });

  describe('Binary Plist Functions', function () {
    it('should detect, create and parse binary plists', function () {
      // Detection
      const binaryPlist = createBinaryPlist(expectedPlistObject);
      assert.strictEqual(isBinaryPlist(binaryPlist), true);
      assert.strictEqual(isBinaryPlist(Buffer.from(sampleXmlPlistContent)), false);
      // Create and verify
      assert.strictEqual(Buffer.isBuffer(binaryPlist), true);
      assert.strictEqual(binaryPlist.slice(0, 6).toString(), 'bplist');

      // Parse
      const parsedObj = parseBinaryPlist(sampleBinaryPlistContent) as Record<string, any>;
      assert.ok(typeof parsedObj === 'object' && parsedObj !== null && !Array.isArray(parsedObj));
      assert.strictEqual(parsedObj.stringValue, 'Hello, World!');
      assert.strictEqual(parsedObj.integerValue, 42);
      assert.ok(Math.abs(parsedObj.realValue - 3.14159) <= 0.00001);
      assert.strictEqual(parsedObj.booleanTrue, true);
      assert.strictEqual(parsedObj.booleanFalse, false);
    });

    it('should size the trailer integers so CoreFoundation accepts the result', function () {
      // CoreFoundation rejects a binary plist whose offset table offset does not fit into the
      // declared offset int size, even when every object offset does, and likewise whose object
      // count does not fit into the object ref size.
      for (const length of OFFSET_TABLE_BOUNDARY_LENGTHS) {
        const obj = {value: 'x'.repeat(length)};
        const binaryPlist = createBinaryPlist(obj);
        const {offsetIntSize, objectRefSize, numObjects, offsetTableOffset} = readBinaryPlistTrailer(binaryPlist);

        assert.ok(
          offsetTableOffset < 2 ** (8 * offsetIntSize),
          `offset table offset ${offsetTableOffset} does not fit into ${offsetIntSize} byte(s) (string length ${length})`,
        );
        assert.ok(
          numObjects < 2 ** (8 * objectRefSize),
          `object count ${numObjects} does not fit into ${objectRefSize} byte(s) (string length ${length})`,
        );
        assert.deepStrictEqual(parseBinaryPlist(binaryPlist), obj, `round-trip failed (string length ${length})`);
      }
    });
  });

  describe('Binary Plist Integer Signedness', function () {
    /** Dict holding `value` as a 2-byte integer. */
    function buildTwoByteIntPlist(value: number): Buffer {
      const header = Buffer.from('bplist00', 'ascii');
      const key = Buffer.concat([Buffer.from([0x51]), Buffer.from('v', 'ascii')]);
      const intBytes = Buffer.alloc(2);
      intBytes.writeUInt16BE(value);
      const objects = [Buffer.from([0xd1, 0x01, 0x02]), key, Buffer.concat([Buffer.from([0x11]), intBytes])];
      const offsets: number[] = [];
      let offset = header.length;
      for (const object of objects) {
        offsets.push(offset);
        offset += object.length;
      }
      const trailer = Buffer.alloc(32);
      trailer.writeUInt8(1, 6);
      trailer.writeUInt8(1, 7);
      trailer.writeBigUInt64BE(BigInt(objects.length), 8);
      trailer.writeBigUInt64BE(0n, 16);
      trailer.writeBigUInt64BE(BigInt(offset), 24);
      return Buffer.concat([header, ...objects, Buffer.from(offsets), trailer]);
    }

    it('should parse 2-byte integers above 32767 as unsigned', function () {
      // Ephemeral ports land in this range.
      for (const value of [8080, 32767, 32768, 54584, 62078, 65535]) {
        const parsed = parseBinaryPlist(buildTwoByteIntPlist(value)) as PlistDictionary;
        assert.strictEqual(parsed.v, value);
      }
    });

    it('should round-trip negative integers', function () {
      for (const value of [-1, -42, -100, -128, -200, -30000, -32768, -70000, -2147483649]) {
        const parsed = parseBinaryPlist(createBinaryPlist({value})) as PlistDictionary;
        assert.strictEqual(parsed.value, value);
      }
    });

    it('should round-trip non-negative integers across width boundaries', function () {
      for (const value of [0, 1, 127, 128, 255, 256, 32767, 32768, 54584, 65535, 65536, 4294967295, 4294967296]) {
        const parsed = parseBinaryPlist(createBinaryPlist({value})) as PlistDictionary;
        assert.strictEqual(parsed.value, value);
      }
    });
  });

  describe('Unified Plist Functions', function () {
    it('should auto-detect and parse both XML and binary plists', function () {
      // XML parsing
      const xmlResult = parsePlist(sampleXmlPlistContent) as Record<string, any>;
      assert.ok(typeof xmlResult === 'object' && xmlResult !== null && !Array.isArray(xmlResult));
      assert.strictEqual(xmlResult.stringValue, 'Hello, World!');
      assert.strictEqual(xmlResult.integerValue, 42);

      // Binary parsing
      const binaryResult = parsePlist(sampleBinaryPlistContent) as Record<string, any>;
      assert.ok(typeof binaryResult === 'object' && binaryResult !== null && !Array.isArray(binaryResult));
      assert.strictEqual(binaryResult.stringValue, 'Hello, World!');
      assert.strictEqual(binaryResult.integerValue, 42);

      // Error handling
      assert.throws(() => parsePlist('not a plist'));
    });

    it('should create plists in both formats', function () {
      // Default XML creation
      const xmlResult = createPlist(expectedPlistObject);
      assert.ok(typeof xmlResult === 'string');
      assert.ok((xmlResult as string).includes('<?xml version="1.0"'));

      // Binary creation
      const binaryResult = createPlist(expectedPlistObject, true);
      assert.strictEqual(Buffer.isBuffer(binaryResult), true);
      assert.strictEqual(isBinaryPlist(binaryResult as Buffer), true);
    });
  });

  describe('Edge Cases and Data Types', function () {
    it('should handle various data types and edge cases', function () {
      const complexObj: PlistDictionary = {
        nullValue: null,
        emptyString: '',
        zero: 0,
        negativeNumber: -42,
        largeNumber: 9007199254740991, // Max safe integer
        emptyArray: [],
        emptyDict: {},
        booleanArray: [true, false, true],
        mixedArray: [1, 'string', true, null, {key: 'value'}],
      };

      // Test round-trip through XML format
      const xmlResult = createXmlPlist(complexObj);
      const parsedXmlObj = parseXmlPlist(xmlResult) as Record<string, any>;

      // Verify key data types are preserved
      assert.strictEqual(parsedXmlObj.emptyString, '');
      assert.strictEqual(parsedXmlObj.zero, 0);
      assert.strictEqual(parsedXmlObj.negativeNumber, -42);
      assert.strictEqual(parsedXmlObj.largeNumber, 9007199254740991);
      assert.ok(Array.isArray(parsedXmlObj.emptyArray));
      assert.strictEqual(parsedXmlObj.emptyArray.length, 0);
      assert.ok(
        typeof parsedXmlObj.emptyDict === 'object' &&
          parsedXmlObj.emptyDict !== null &&
          !Array.isArray(parsedXmlObj.emptyDict),
      );
      assert.ok(Array.isArray(parsedXmlObj.booleanArray));
      assert.strictEqual(parsedXmlObj.booleanArray.length, 3);

      // Empty object test
      const emptyObj = {};
      const emptyXmlResult = createXmlPlist(emptyObj);
      const parsedEmptyXml = parseXmlPlist(emptyXmlResult);
      assert.deepStrictEqual(parsedEmptyXml, {});
    });

    it('should validate that sample data contains emoji and unicode', function () {
      // Test round-trip with the sample data
      const binary = createBinaryPlist(expectedPlistObject);
      const obj = parseBinaryPlist(binary) as Record<string, any>;
      const xmlResult = createXmlPlist(expectedPlistObject);
      assert.strictEqual(obj.emoji, '😀');
      assert.strictEqual(obj.unicode, '测试');
      // Verify the XML contains the encoded characters
      assert.ok(xmlResult.includes('😀'));
      assert.ok(xmlResult.includes('测试'));
    });
  });
});
