import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { isBinaryPlist } from '../../../src/lib/plist/binary-plist-parser.js';
import { parsePlist } from '../../../src/lib/plist/unified-plist-parser.js';
import type { PlistDictionary } from '../../../src/lib/types.js';

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(__dirname, 'fixtures');

describe('Unified Plist Parser', function () {
  let sampleXmlPlistPath: string;
  let sampleXmlPlistContent: string;
  let sampleBinaryPlistPath: string;
  let sampleBinaryPlistContent: Buffer;

  before(function () {
    sampleXmlPlistPath = path.join(FIXTURES_PATH, 'sample.xml.plist');
    sampleXmlPlistContent = fs.readFileSync(sampleXmlPlistPath, 'utf8');

    sampleBinaryPlistPath = path.join(FIXTURES_PATH, 'sample.binary.plist');
    sampleBinaryPlistContent = fs.readFileSync(sampleBinaryPlistPath);
  });

  describe('Format Detection and Parsing', function () {
    it('should correctly detect and parse XML plists', function () {
      // Test with string input
      const resultFromString = parsePlist(
        sampleXmlPlistContent,
      ) as PlistDictionary;
      expect(resultFromString).to.be.an('object');
      expect(resultFromString).to.have.property('stringValue', 'Hello, World!');
      expect(resultFromString).to.have.property('integerValue', 42);

      // Test with Buffer input (converted from string)
      const xmlBuffer = Buffer.from(sampleXmlPlistContent, 'utf8');
      const resultFromBuffer = parsePlist(xmlBuffer) as PlistDictionary;
      expect(resultFromBuffer).to.be.an('object');
      expect(resultFromBuffer).to.have.property('stringValue', 'Hello, World!');
    });

    it('should correctly detect and parse binary plists', function () {
      // Verify it's actually a binary plist
      expect(isBinaryPlist(sampleBinaryPlistContent)).to.be.true;

      // Parse the binary plist
      const result = parsePlist(sampleBinaryPlistContent) as PlistDictionary;
      expect(result).to.be.an('object');
      expect(result).to.have.property('stringValue', 'Hello, World!');
      expect(result).to.have.property('integerValue', 42);
    });

    it('should throw an error for invalid plist data', function () {
      try {
        parsePlist('not a plist at all');
        expect.fail('Should have thrown an error for invalid data');
      } catch (error) {
        expect(error).to.exist;
      }

      try {
        parsePlist(Buffer.from('not a plist at all'));
        expect.fail('Should have thrown an error for invalid data buffer');
      } catch (error) {
        expect(error).to.exist;
      }

      try {
        parsePlist('');
        expect.fail('Should have thrown an error for empty string');
      } catch (error) {
        expect(error).to.exist;
      }

      try {
        parsePlist(Buffer.alloc(0));
        expect.fail('Should have thrown an error for empty buffer');
      } catch (error) {
        expect(error).to.exist;
      }

      try {
        parsePlist('<plist><dict><key>test</key></dict></plist>');
        expect.fail('Should have thrown an error for malformed XML');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('Edge Cases', function () {
    it('should handle XML with processing instructions', function () {
      const xmlWithPI = `<?xml version="1.0" encoding="UTF-8"?>
      <?xml-stylesheet type="text/css" href="style.css"?>
      <plist version="1.0">
      <dict>
        <key>test</key>
        <string>value</string>
      </dict>
      </plist>`;

      const result = parsePlist(xmlWithPI) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle XML with DOCTYPE declarations', function () {
      const xmlWithDoctype = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>test</key>
        <string>value</string>
      </dict>
      </plist>`;

      const result = parsePlist(xmlWithDoctype) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle XML with Unicode characters', function () {
      const xmlWithUnicode = `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
      <dict>
        <key>unicodeKey</key>
        <string>こんにちは世界</string>
      </dict>
      </plist>`;

      const result = parsePlist(xmlWithUnicode) as PlistDictionary;
      expect(result).to.have.property('unicodeKey', 'こんにちは世界');
    });

    it('should handle XML with special characters that need escaping', function () {
      const xmlWithSpecialChars = `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
      <dict>
        <key>specialChars</key>
        <string>&lt;Hello &amp; World&gt;</string>
      </dict>
      </plist>`;

      const result = parsePlist(xmlWithSpecialChars) as PlistDictionary;
      expect(result).to.have.property('specialChars', '<Hello & World>');
    });
  });

  describe('Robustness Tests', function () {
    it('should handle XML with extra whitespace', function () {
      const xmlWithWhitespace = `
        <?xml version="1.0" encoding="UTF-8"?>
        
        <plist version="1.0">
          <dict>
            <key>  spaced  key  </key>
            <string>  spaced  value  </string>
          </dict>
        </plist>
        
      `;

      const result = parsePlist(xmlWithWhitespace) as PlistDictionary;
      expect(result).to.have.property('  spaced  key  ', '  spaced  value  ');
    });

    it('should handle XML with comments', function () {
      const xmlWithComments = `<?xml version="1.0" encoding="UTF-8"?>
      <!-- This is a comment -->
      <plist version="1.0">
      <dict>
        <!-- Another comment -->
        <key>commentedKey</key>
        <string>value</string> <!-- End comment -->
      </dict>
      </plist>`;

      const result = parsePlist(xmlWithComments) as PlistDictionary;
      expect(result).to.have.property('commentedKey', 'value');
    });

    it('should handle XML with mixed line endings', function () {
      // Create XML with mixed line endings (CR, LF, CRLF)
      const xmlWithMixedLineEndings =
        '<?xml version="1.0" encoding="UTF-8"?>\r' +
        '<plist version="1.0">\n' +
        '<dict>\r\n' +
        '<key>test</key>\r' +
        '<string>value</string>\n' +
        '</dict>\r\n' +
        '</plist>';

      const result = parsePlist(xmlWithMixedLineEndings) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should handle XML with BOM (Byte Order Mark)', function () {
      const bomPrefix = Buffer.from([0xef, 0xbb, 0xbf]);
      const xmlContent = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>',
      );
      const xmlWithBOM = Buffer.concat([bomPrefix, xmlContent]);

      const result = parsePlist(xmlWithBOM) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });

  describe('Error Recovery', function () {
    it('should recover from XML with content before XML declaration', function () {
      const xmlWithPrefix =
        'Some garbage data<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>test</key><string>value</string></dict></plist>';

      const result = parsePlist(xmlWithPrefix) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });

    it('should recover from XML with multiple XML declarations', function () {
      const xmlWithMultipleDeclarations =
        '<?xml version="1.0" encoding="UTF-8"?><?xml version="1.1"?><plist><dict><key>test</key><string>value</string></dict></plist>';

      const result = parsePlist(xmlWithMultipleDeclarations) as PlistDictionary;
      expect(result).to.have.property('test', 'value');
    });
  });
});
