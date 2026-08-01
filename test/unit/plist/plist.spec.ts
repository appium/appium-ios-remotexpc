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
