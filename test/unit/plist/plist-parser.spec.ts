import { expect } from 'chai';

import { parsePlist as parseXmlPlist } from '../../../src/lib/plist/plist-parser.js';
import {
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
  isValidXml,
  trimBeforeXmlDeclaration,
} from '../../../src/lib/plist/utils.js';
import type {
  PlistArray,
  PlistDictionary,
  PlistValue,
} from '../../../src/lib/types.js';

describe('Plist Parser', function () {
  describe('XML Cleaning Logic', function () {
    it('should detect Unicode replacement characters', function () {
      const validXml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';
      const invalidXml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>val�ue</string></dict></plist>';

      expect(hasUnicodeReplacementCharacter(validXml)).to.be.false;
      expect(hasUnicodeReplacementCharacter(invalidXml)).to.be.true;
    });

    it('should find the position of the first replacement character', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>val�ue</string></dict></plist>';
      const position = findFirstReplacementCharacter(xml);

      expect(position).to.equal(xml.indexOf('�'));
      expect(position).to.be.greaterThan(0);
    });

    it('should handle the case where there is no tag before the replacement character', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';

      const result = parseXmlPlist(xml);

      expect(result).to.have.property('test', 'value');
    });

    it('should handle the case where there is no tag after the replacement character', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>�';

      const result = parseXmlPlist(xml);

      expect(result).to.have.property('test', 'value');
    });
  });

  describe('XML Preprocessing Functions', function () {
    it('should trim content before XML declaration', function () {
      const xml =
        'garbage data<?xml version="1.0" encoding="UTF-8"?><plist></plist>';
      const trimmed = trimBeforeXmlDeclaration(xml);

      expect(trimmed).to.equal(
        '<?xml version="1.0" encoding="UTF-8"?><plist></plist>',
      );
    });

    it('should fix multiple XML declarations', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><some-tag><?xml version="1.1"?><plist></plist>';
      const fixed = fixMultipleXmlDeclarations(xml);

      expect(fixed).to.include('<?xml version="1.0" encoding="UTF-8"?>');
      expect(fixed).to.include('<some-tag>');
      expect(fixed).to.include('<plist></plist>');
      expect(fixed).not.to.include('<?xml version="1.1"?>');
    });

    it('should validate XML content', function () {
      expect(isValidXml('<?xml version="1.0"?><plist></plist>')).to.be.true;
      expect(isValidXml('')).to.be.false;
      expect(isValidXml('  ')).to.be.false;
      expect(isValidXml('not xml')).to.be.false;
    });
  });

  describe('Error Handling', function () {
    it('should handle completely invalid XML', function () {
      try {
        parseXmlPlist('not xml at all');
        expect.fail('Should have thrown an error for invalid XML');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle XML without a plist element', function () {
      try {
        parseXmlPlist('<?xml version="1.0"?><not-a-plist></not-a-plist>');
        expect.fail('Should have thrown an error for missing plist element');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle XML with malformed tags', function () {
      try {
        parseXmlPlist(
          '<?xml version="1.0"?><plist><dict><key>test</key><string>value</string></dict>',
        );
        expect.fail('Should have thrown an error for malformed tags');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('Complex XML Structures', function () {
    it('should parse nested dictionaries correctly', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>level1</key>
          <dict>
            <key>level2</key>
            <dict>
              <key>level3</key>
              <string>deep value</string>
            </dict>
          </dict>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('level1');

      // Type assertions for nested properties
      const level1 = result.level1 as PlistDictionary;
      expect(level1).to.have.property('level2');

      const level2 = level1.level2 as PlistDictionary;
      expect(level2).to.have.property('level3', 'deep value');
    });

    it('should parse mixed arrays and dictionaries', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>mixedArray</key>
          <array>
            <string>text</string>
            <integer>123</integer>
            <dict>
              <key>nestedKey</key>
              <string>nestedValue</string>
            </dict>
          </array>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('mixedArray').that.is.an('array');

      // Type assertion for array
      const mixedArray = result.mixedArray as PlistArray;
      expect(mixedArray).to.have.lengthOf(3);
      expect(mixedArray[0]).to.equal('text');
      expect(mixedArray[1]).to.equal(123);

      // Type assertion for nested object in array
      const nestedObj = mixedArray[2] as PlistDictionary;
      expect(nestedObj).to.have.property('nestedKey', 'nestedValue');
    });

    it('should handle XML with comments', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <!-- This is a comment -->
          <key>commentedKey</key>
          <string>value</string>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('commentedKey', 'value');
    });

    it('should handle XML with CDATA sections', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>cdataKey</key>
          <string><![CDATA[<html>This is HTML content</html>]]></string>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property(
        'cdataKey',
        '<html>This is HTML content</html>',
      );
    });
  });

  describe('Special Data Types', function () {
    it('should parse date values correctly', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>dateKey</key>
          <date>2023-05-21T12:34:56Z</date>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('dateKey');

      // Type assertion for date
      const dateValue = result.dateKey as Date;
      expect(dateValue).to.be.instanceOf(Date);
      expect(dateValue.toISOString()).to.equal('2023-05-21T12:34:56.000Z');
    });

    it('should parse data values correctly', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>dataKey</key>
          <data>SGVsbG8gV29ybGQ=</data>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('dataKey');

      // Type assertion for buffer
      const dataValue = result.dataKey as Buffer;
      expect(Buffer.isBuffer(dataValue)).to.be.true;
      expect(dataValue.toString()).to.equal('Hello World');
    });

    it('should handle empty elements correctly', function () {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0">
        <dict>
          <key>emptyString</key>
          <string></string>
          <key>emptyArray</key>
          <array></array>
          <key>emptyDict</key>
          <dict></dict>
        </dict>
        </plist>
      `;

      const result = parseXmlPlist(xml);
      expect(result).to.have.property('emptyString', '');
      expect(result)
        .to.have.property('emptyArray')
        .that.is.an('array')
        .with.lengthOf(0);
      expect(result).to.have.property('emptyDict').that.is.an('object');

      // Type assertion for empty dictionary
      const emptyDict = result.emptyDict as PlistDictionary;
      expect(Object.keys(emptyDict)).to.have.lengthOf(0);
    });
  });
});
