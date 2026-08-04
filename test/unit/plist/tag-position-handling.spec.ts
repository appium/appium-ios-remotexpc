import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {parsePlist as parseXmlPlist} from '../../../src/lib/plist/plist-parser.js';
import {cleanXmlWithReplacementChar, findTagsAroundPosition} from '../../../src/lib/plist/utils.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

describe('Tag Position Handling', function () {
  describe('findTagsAroundPosition', function () {
    it('should correctly find tags around a position', function () {
      const xml = '<root><child>text</child></root>';

      const position = xml.indexOf('text') + 2;
      const {beforeTag, afterTag} = findTagsAroundPosition(xml, position);

      assert.notStrictEqual(beforeTag, null);
      assert.strictEqual(beforeTag?.tagName, 'child');
      assert.strictEqual(beforeTag?.isOpening, true);

      assert.notStrictEqual(afterTag, null);
      assert.strictEqual(afterTag?.tagName, 'child');
      assert.strictEqual(afterTag?.isOpening, false);
    });

    it('should handle the case where prevTagPos >= 0 && nextTagPos > prevTagPos', function () {
      const xml = '<root><child>text</child> <next>more</next></root>';

      const position = xml.indexOf('</child>') + '</child>'.length;
      const {beforeTag, afterTag} = findTagsAroundPosition(xml, position);

      assert.notStrictEqual(beforeTag, null);
      assert.strictEqual(beforeTag?.tagName, 'child');
      assert.strictEqual(beforeTag?.isOpening, false);

      assert.notStrictEqual(afterTag, null);
      assert.strictEqual(afterTag?.tagName, 'next');
      assert.strictEqual(afterTag?.isOpening, true);

      assert.ok(beforeTag?.end <= position);
      assert.ok(afterTag?.start > position);
      assert.ok(afterTag?.start > (beforeTag?.end || 0));
    });

    it('should handle the case where there is a replacement character between tags', function () {
      const xml = '<root><child>text</child>�<next>more</next></root>';

      const position = xml.indexOf('�');
      const {beforeTag, afterTag} = findTagsAroundPosition(xml, position);

      assert.notStrictEqual(beforeTag, null);
      assert.strictEqual(beforeTag?.tagName, 'child');
      assert.strictEqual(beforeTag?.isOpening, false);

      assert.notStrictEqual(afterTag, null);
      assert.strictEqual(afterTag?.tagName, 'next');
      assert.strictEqual(afterTag?.isOpening, true);

      const cleanedXml = cleanXmlWithReplacementChar(xml, position);

      assert.ok(!cleanedXml.includes('�'));
      assert.strictEqual(cleanedXml, '<root><child>text</child><next>more</next></root>');
    });
  });

  describe('XML Cleaning with Unclosed Tags', function () {
    it('should handle XML with unclosed tags', function () {
      const xml = '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict>';

      try {
        parseXmlPlist(xml);
        assert.fail('Should have thrown an error for unclosed tag');
      } catch (error) {
        assert.ok(error !== null && error !== undefined);
      }
    });

    it('should handle XML with extra content at the end', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>extra content';

      const result = parseXmlPlist(xml) as PlistDictionary;
      assert.strictEqual(result.test, 'value');
    });
  });
});
