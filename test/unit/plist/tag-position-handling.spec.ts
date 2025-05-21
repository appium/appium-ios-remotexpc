import { expect } from 'chai';

import { parsePlist as parseXmlPlist } from '../../../src/lib/plist/plist-parser.js';
import {
  cleanXmlWithReplacementChar,
  findTagsAroundPosition,
} from '../../../src/lib/plist/utils.js';
import type { PlistDictionary } from '../../../src/lib/types.js';

describe('Tag Position Handling', function () {
  describe('findTagsAroundPosition', function () {
    it('should correctly find tags around a position', function () {
      const xml = '<root><child>text</child></root>';

      const position = xml.indexOf('text') + 2;
      const { beforeTag, afterTag } = findTagsAroundPosition(xml, position);

      expect(beforeTag).to.not.be.null;
      expect(beforeTag?.tagName).to.equal('child');
      expect(beforeTag?.isOpening).to.be.true;

      expect(afterTag).to.not.be.null;
      expect(afterTag?.tagName).to.equal('child');
      expect(afterTag?.isOpening).to.be.false;
    });

    it('should handle the case where prevTagPos >= 0 && nextTagPos > prevTagPos', function () {
      const xml = '<root><child>text</child> <next>more</next></root>';

      const position = xml.indexOf('</child>') + '</child>'.length;
      const { beforeTag, afterTag } = findTagsAroundPosition(xml, position);

      expect(beforeTag).to.not.be.null;
      expect(beforeTag?.tagName).to.equal('child');
      expect(beforeTag?.isOpening).to.be.false;

      expect(afterTag).to.not.be.null;
      expect(afterTag?.tagName).to.equal('next');
      expect(afterTag?.isOpening).to.be.true;

      expect(beforeTag?.end).to.be.lessThanOrEqual(position);
      expect(afterTag?.start).to.be.greaterThan(position);
      expect(afterTag?.start).to.be.greaterThan(beforeTag?.end || 0);
    });

    it('should handle the case where there is a replacement character between tags', function () {
      const xml = '<root><child>text</child>�<next>more</next></root>';

      const position = xml.indexOf('�');
      const { beforeTag, afterTag } = findTagsAroundPosition(xml, position);

      expect(beforeTag).to.not.be.null;
      expect(beforeTag?.tagName).to.equal('child');
      expect(beforeTag?.isOpening).to.be.false;

      expect(afterTag).to.not.be.null;
      expect(afterTag?.tagName).to.equal('next');
      expect(afterTag?.isOpening).to.be.true;

      const cleanedXml = cleanXmlWithReplacementChar(xml, position);

      expect(cleanedXml).to.not.include('�');
      expect(cleanedXml).to.equal(
        '<root><child>text</child><next>more</next></root>',
      );
    });
  });

  describe('XML Cleaning with Unclosed Tags', function () {
    it('should handle XML with unclosed tags', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict>';

      try {
        parseXmlPlist(xml);
        expect.fail('Should have thrown an error for unclosed tag');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle XML with extra content at the end', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>extra content';

      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });
});
