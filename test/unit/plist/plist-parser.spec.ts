import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parsePlist as parseXmlPlist} from '../../../src/lib/plist/plist-parser.js';
import {
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
  isValidXml,
  trimBeforeXmlDeclaration,
} from '../../../src/lib/plist/utils.js';
import type {PlistArray, PlistDictionary} from '../../../src/lib/types.js';

describe('Plist Parser', function () {
  describe('XML Cleaning Logic', function () {
    it('should detect Unicode replacement characters', function () {
      const validXml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';
      const invalidXml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>val�ue</string></dict></plist>';

      assert.strictEqual(hasUnicodeReplacementCharacter(validXml), false);
      assert.strictEqual(hasUnicodeReplacementCharacter(invalidXml), true);
    });

    it('should find the position of the first replacement character', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>val�ue</string></dict></plist>';
      const position = findFirstReplacementCharacter(xml);

      assert.strictEqual(position, xml.indexOf('�'));
      assert.ok(position > 0);
    });

    it('should handle the case where there is no tag before the replacement character', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';

      const result = parseXmlPlist(xml);

      assert.strictEqual(result.test, 'value');
    });

    it('should handle the case where there is no tag after the replacement character', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>�';

      const result = parseXmlPlist(xml);

      assert.strictEqual(result.test, 'value');
    });
  });

  describe('XML Preprocessing Functions', function () {
    it('should trim content before XML declaration', function () {
      const xml = 'garbage data<?xml version="1.0" encoding="UTF-8"?><plist></plist>';
      const trimmed = trimBeforeXmlDeclaration(xml);

      assert.strictEqual(trimmed, '<?xml version="1.0" encoding="UTF-8"?><plist></plist>');
    });

    it('should fix multiple XML declarations', function () {
      const xml = '<?xml version="1.0" encoding="UTF-8"?><some-tag><?xml version="1.1"?><plist></plist>';
      const fixed = fixMultipleXmlDeclarations(xml);

      assert.ok(fixed.includes('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.ok(fixed.includes('<some-tag>'));
      assert.ok(fixed.includes('<plist></plist>'));
      assert.ok(!fixed.includes('<?xml version="1.1"?>'));
    });

    it('should validate XML content', function () {
      assert.strictEqual(isValidXml('<?xml version="1.0"?><plist></plist>'), true);
      assert.strictEqual(isValidXml(''), false);
      assert.strictEqual(isValidXml('  '), false);
      assert.strictEqual(isValidXml('not xml'), false);
    });
  });

  describe('Error Handling', function () {
    it('should handle completely invalid XML', function () {
      try {
        parseXmlPlist('not xml at all');
        assert.fail('Should have thrown an error for invalid XML');
      } catch (error) {
        assert.ok(error !== null && error !== undefined);
      }
    });

    it('should handle XML without a plist element', function () {
      try {
        parseXmlPlist('<?xml version="1.0"?><not-a-plist></not-a-plist>');
        assert.fail('Should have thrown an error for missing plist element');
      } catch (error) {
        assert.ok(error !== null && error !== undefined);
      }
    });

    it('should handle XML with malformed tags', function () {
      try {
        parseXmlPlist('<?xml version="1.0"?><plist><dict><key>test</key><string>value</string></dict>');
        assert.fail('Should have thrown an error for malformed tags');
      } catch (error) {
        assert.ok(error !== null && error !== undefined);
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
      assert.ok('level1' in result);

      // Type assertions for nested properties
      const level1 = result.level1 as PlistDictionary;
      assert.ok('level2' in level1);

      const level2 = level1.level2 as PlistDictionary;
      assert.strictEqual(level2.level3, 'deep value');
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
      assert.ok(Array.isArray(result.mixedArray));

      // Type assertion for array
      const mixedArray = result.mixedArray as PlistArray;
      assert.strictEqual(mixedArray.length, 3);
      assert.strictEqual(mixedArray[0], 'text');
      assert.strictEqual(mixedArray[1], 123);

      // Type assertion for nested object in array
      const nestedObj = mixedArray[2] as PlistDictionary;
      assert.strictEqual(nestedObj.nestedKey, 'nestedValue');
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
      assert.strictEqual(result.commentedKey, 'value');
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
      assert.strictEqual(result.cdataKey, '<html>This is HTML content</html>');
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
      assert.ok('dateKey' in result);

      // Type assertion for date
      const dateValue = result.dateKey as Date;
      assert.ok(dateValue instanceof Date);
      assert.strictEqual(dateValue.toISOString(), '2023-05-21T12:34:56.000Z');
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
      assert.ok('dataKey' in result);

      // Type assertion for buffer
      const dataValue = result.dataKey as Buffer;
      assert.strictEqual(Buffer.isBuffer(dataValue), true);
      assert.strictEqual(dataValue.toString(), 'Hello World');
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
      assert.strictEqual(result.emptyString, '');
      assert.ok(Array.isArray(result.emptyArray));
      assert.strictEqual(result.emptyArray.length, 0);
      assert.ok(typeof result.emptyDict === 'object' && result.emptyDict !== null && !Array.isArray(result.emptyDict));

      // Type assertion for empty dictionary
      const emptyDict = result.emptyDict as PlistDictionary;
      assert.strictEqual(Object.keys(emptyDict).length, 0);
    });
  });
});
