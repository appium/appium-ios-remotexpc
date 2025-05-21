import { expect } from 'chai';

import { parsePlist as parseXmlPlist } from '../../../src/lib/plist/plist-parser.js';
import { parsePlist as unifiedParsePlist } from '../../../src/lib/plist/unified-plist-parser.js';
import type { PlistDictionary } from '../../../src/lib/types.js';

describe('XML Error Handling', function () {
  describe('Unicode Replacement Character Handling', function () {
    it('should handle Unicode replacement characters at the beginning', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';
      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle Unicode replacement characters at the end', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>�';
      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle Unicode replacement characters between tags', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist>�<dict><key>test</key><string>value</string></dict></plist>';
      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });

  describe('Extra Content Handling', function () {
    it('should handle extra content at the end of the document', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>extra content';

      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle extra content before the XML declaration', function () {
      const xml =
        'extra content<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';
      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });

  describe('Unclosed Tags Handling', function () {
    it('should handle unclosed plist tag', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict>';

      try {
        parseXmlPlist(xml);
        expect.fail('Should have thrown an error for unclosed plist tag');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should handle unclosed dict tag', function () {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></plist>';

      try {
        parseXmlPlist(xml);
        expect.fail('Should have thrown an error for unclosed dict tag');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('Combined Error Scenarios', function () {
    it('should handle both Unicode replacement characters and extra content', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>extra content';

      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle multiple Unicode replacement characters', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?>�<plist><dict><key>test</key><string>value</string></dict></plist>�';

      const result = parseXmlPlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });

  describe('Unified Parser Error Handling', function () {
    it('should handle errors in the unified parser for XML content', function () {
      const xml =
        '�<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>extra content';

      const result = unifiedParsePlist(xml) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });
});
