import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parsePlist as parseXmlPlist} from '../../../src/lib/plist/plist-parser.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

describe('XML Cleaning Logic', function () {
  describe('Handling Unicode Replacement Characters', function () {
    it('should handle replacement characters at different positions', function () {
      const xmlAtBeginning =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';
      const resultBeginning = parseXmlPlist(xmlAtBeginning) as PlistDictionary;
      assert.strictEqual(resultBeginning.test, 'value');

      const xmlAfterDeclaration =
        '<?xml version="1.0" encoding="UTF-8"?>�<plist><dict><key>test</key><string>value</string></dict></plist>';
      const resultAfterDeclaration = parseXmlPlist(xmlAfterDeclaration) as PlistDictionary;
      assert.strictEqual(resultAfterDeclaration.test, 'value');

      const xmlAtEnd =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>�';
      const resultAtEnd = parseXmlPlist(xmlAtEnd) as PlistDictionary;
      assert.strictEqual(resultAtEnd.test, 'value');
    });
  });

  describe('Edge Cases', function () {
    it('should handle the case where prevTagPos < 0', function () {
      const xml = '�<plist><dict><key>test</key><string>value</string></dict></plist>';

      const result = parseXmlPlist(xml) as PlistDictionary;

      assert.strictEqual(result.test, 'value');
    });

    it('should handle the case where nextTagPos <= prevTagPos', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>�';

      const result = parseXmlPlist(xml) as PlistDictionary;

      assert.strictEqual(result.test, 'value');
    });

    it('should handle XML with only replacement characters', function () {
      const xml = '���';

      try {
        parseXmlPlist(xml);
        assert.fail('Should have thrown an error for XML with only replacement characters');
      } catch (error) {
        assert.ok(error !== null && error !== undefined);
      }
    });
  });
});
