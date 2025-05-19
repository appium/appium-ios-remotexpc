import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createBinaryPlist,
  createPlist,
  createXmlPlist,
  isBinaryPlist,
  parseBinaryPlist,
  parsePlist,
  parseXmlPlist,
} from '../../../src/lib/plist/index.js';
import type { PlistDictionary } from '../../../src/lib/types.js';

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(__dirname, 'fixtures');

describe('Plist Module', function () {
  let sampleXmlPlistPath: string;
  let sampleXmlPlistContent: string;
  let sampleBinaryPlistPath: string;
  let sampleBinaryPlistContent: Buffer;
  let expectedPlistObject: PlistDictionary;

  before(function () {
    sampleXmlPlistPath = path.join(FIXTURES_PATH, 'sample.xml.plist');
    sampleXmlPlistContent = fs.readFileSync(sampleXmlPlistPath, 'utf8');

    sampleBinaryPlistPath = path.join(FIXTURES_PATH, 'sample.binary.plist');
    sampleBinaryPlistContent = fs.readFileSync(sampleBinaryPlistPath);

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
    };
  });

  describe('XML Plist Functions', function () {
    it('should parse XML plists correctly', function () {
      const result = parseXmlPlist(sampleXmlPlistContent);

      // Basic types
      expect(result).to.be.an('object');
      expect(result).to.have.property('stringValue', 'Hello, World!');
      expect(result).to.have.property('integerValue', 42);
      expect(result)
        .to.have.property('realValue')
        .that.is.closeTo(3.14159, 0.00001);
      expect(result).to.have.property('booleanTrue', true);
      expect(result).to.have.property('booleanFalse', false);

      // Complex types
      expect(result)
        .to.have.property('arrayValue')
        .that.is.an('array')
        .with.lengthOf(3);
      expect(result).to.have.property('dictValue').that.is.an('object');
      expect(result).to.have.property('specialChars', '<Hello & World>');

      // Error handling
      expect(() => parseXmlPlist('not a valid xml')).to.throw();
    });

    it('should create XML plists correctly', function () {
      const xmlContent = createXmlPlist(expectedPlistObject);

      // Check structure
      expect(xmlContent).to.include('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xmlContent).to.include('<!DOCTYPE plist');
      expect(xmlContent).to.include('<plist version="1.0">');

      // Check content
      expect(xmlContent).to.include('<key>stringValue</key>');
      expect(xmlContent).to.include('<string>Hello, World!</string>');
      expect(xmlContent).to.include('<key>integerValue</key>');
      expect(xmlContent).to.include('<integer>42</integer>');
      expect(xmlContent).to.include('&lt;Hello &amp; World&gt;');

      // Round-trip test
      const parsedBack = parseXmlPlist(xmlContent);
      expect(parsedBack).to.have.property('stringValue', 'Hello, World!');
      expect(parsedBack).to.have.property('integerValue', 42);
    });
  });

  describe('Binary Plist Functions', function () {
    it('should detect, create and parse binary plists', function () {
      // Detection
      const binaryPlist = createBinaryPlist(expectedPlistObject);
      expect(isBinaryPlist(binaryPlist)).to.be.true;
      expect(isBinaryPlist(Buffer.from(sampleXmlPlistContent))).to.be.false;

      // Create and verify
      expect(Buffer.isBuffer(binaryPlist)).to.be.true;
      expect(binaryPlist.slice(0, 6).toString()).to.equal('bplist');

      // Parse
      const parsedObj = parseBinaryPlist(sampleBinaryPlistContent) as Record<
        string,
        any
      >;
      expect(parsedObj).to.be.an('object');
      expect(parsedObj).to.have.property('stringValue', 'Hello, World!');
      expect(parsedObj).to.have.property('integerValue', 42);
      expect(parsedObj)
        .to.have.property('realValue')
        .that.is.closeTo(3.14159, 0.00001);
      expect(parsedObj).to.have.property('booleanTrue', true);
      expect(parsedObj).to.have.property('booleanFalse', false);
    });
  });

  describe('Unified Plist Functions', function () {
    it('should auto-detect and parse both XML and binary plists', function () {
      // XML parsing
      const xmlResult = parsePlist(sampleXmlPlistContent) as Record<
        string,
        any
      >;
      expect(xmlResult).to.be.an('object');
      expect(xmlResult).to.have.property('stringValue', 'Hello, World!');
      expect(xmlResult).to.have.property('integerValue', 42);

      // Binary parsing
      const binaryResult = parsePlist(sampleBinaryPlistContent) as Record<
        string,
        any
      >;
      expect(binaryResult).to.be.an('object');
      expect(binaryResult).to.have.property('stringValue', 'Hello, World!');
      expect(binaryResult).to.have.property('integerValue', 42);

      // Error handling
      expect(() => parsePlist('not a plist')).to.throw();
    });

    it('should create plists in both formats', function () {
      // Default XML creation
      const xmlResult = createPlist(expectedPlistObject);
      expect(xmlResult).to.be.a('string');
      expect(xmlResult as string).to.include('<?xml version="1.0"');

      // Binary creation
      const binaryResult = createPlist(expectedPlistObject, true);
      expect(Buffer.isBuffer(binaryResult)).to.be.true;
      expect(isBinaryPlist(binaryResult as Buffer)).to.be.true;
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
        mixedArray: [1, 'string', true, null, { key: 'value' }],
      };

      // Test round-trip through XML format
      const xmlResult = createXmlPlist(complexObj);
      const parsedXmlObj = parseXmlPlist(xmlResult) as Record<string, any>;

      // Verify key data types are preserved
      expect(parsedXmlObj).to.have.property('emptyString', '');
      expect(parsedXmlObj).to.have.property('zero', 0);
      expect(parsedXmlObj).to.have.property('negativeNumber', -42);
      expect(parsedXmlObj).to.have.property('largeNumber', 9007199254740991);
      expect(parsedXmlObj)
        .to.have.property('emptyArray')
        .that.is.an('array')
        .with.lengthOf(0);
      expect(parsedXmlObj).to.have.property('emptyDict').that.is.an('object');
      expect(parsedXmlObj)
        .to.have.property('booleanArray')
        .that.is.an('array')
        .with.lengthOf(3);

      // Empty object test
      const emptyObj = {};
      const emptyXmlResult = createXmlPlist(emptyObj);
      const parsedEmptyXml = parseXmlPlist(emptyXmlResult);
      expect(parsedEmptyXml).to.deep.equal({});
    });
  });
});
