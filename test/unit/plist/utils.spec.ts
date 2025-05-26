import { expect } from 'chai';

import {
  ensureString,
  escapeXml,
  findFirstReplacementCharacter,
  fixMultipleXmlDeclarations,
  hasUnicodeReplacementCharacter,
  isValidXml,
  isXmlPlistContent,
  trimBeforeXmlDeclaration,
} from '../../../src/lib/plist/utils.js';

describe('Plist Utils', function () {
  describe('ensureString', function () {
    it('should return the input if it is already a string', function () {
      const input = 'test string';
      expect(ensureString(input)).to.equal(input);
    });

    it('should convert a Buffer to a string', function () {
      const buffer = Buffer.from('test buffer');
      expect(ensureString(buffer)).to.equal('test buffer');
    });

    it('should handle empty inputs', function () {
      expect(ensureString('')).to.equal('');
      expect(ensureString(Buffer.alloc(0))).to.equal('');
    });

    it('should handle Unicode characters', function () {
      const unicodeStr = 'こんにちは世界';
      const buffer = Buffer.from(unicodeStr, 'utf8');
      expect(ensureString(buffer)).to.equal(unicodeStr);
    });
  });

  describe('hasUnicodeReplacementCharacter', function () {
    it('should return true if the string contains replacement characters', function () {
      expect(hasUnicodeReplacementCharacter('test�string')).to.be.true;
      expect(hasUnicodeReplacementCharacter('�at the beginning')).to.be.true;
      expect(hasUnicodeReplacementCharacter('at the end�')).to.be.true;
      expect(hasUnicodeReplacementCharacter('multiple��chars')).to.be.true;
    });

    it('should return false if the string does not contain replacement characters', function () {
      expect(hasUnicodeReplacementCharacter('normal string')).to.be.false;
      expect(hasUnicodeReplacementCharacter('')).to.be.false;
    });

    it('should work with Buffer inputs', function () {
      const bufferWithReplacement = Buffer.from('test�string', 'utf8');
      const bufferWithoutReplacement = Buffer.from('normal string', 'utf8');

      expect(hasUnicodeReplacementCharacter(bufferWithReplacement)).to.be.true;
      expect(hasUnicodeReplacementCharacter(bufferWithoutReplacement)).to.be
        .false;
    });
  });

  describe('findFirstReplacementCharacter', function () {
    it('should return the index of the first replacement character', function () {
      expect(findFirstReplacementCharacter('test�string')).to.equal(4);
      expect(findFirstReplacementCharacter('�at the beginning')).to.equal(0);
      expect(findFirstReplacementCharacter('multiple��chars')).to.equal(8);
    });

    it('should return -1 if no replacement character is found', function () {
      expect(findFirstReplacementCharacter('normal string')).to.equal(-1);
      expect(findFirstReplacementCharacter('')).to.equal(-1);
    });

    it('should work with Buffer inputs', function () {
      const bufferWithReplacement = Buffer.from('test�string', 'utf8');
      expect(findFirstReplacementCharacter(bufferWithReplacement)).to.equal(4);
    });
  });

  describe('trimBeforeXmlDeclaration', function () {
    it('should remove content before the XML declaration', function () {
      const input = 'garbage data<?xml version="1.0"?><root></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      expect(trimBeforeXmlDeclaration(input)).to.equal(expected);
    });

    it('should return the original string if there is no XML declaration', function () {
      const input = '<root></root>';
      expect(trimBeforeXmlDeclaration(input)).to.equal(input);
    });

    it('should return the original string if the XML declaration is at the beginning', function () {
      const input = '<?xml version="1.0"?><root></root>';
      expect(trimBeforeXmlDeclaration(input)).to.equal(input);
    });

    it('should work with Buffer inputs', function () {
      const buffer = Buffer.from(
        'garbage data<?xml version="1.0"?><root></root>',
        'utf8',
      );
      const expected = '<?xml version="1.0"?><root></root>';
      expect(trimBeforeXmlDeclaration(buffer)).to.equal(expected);
    });

    it('should handle whitespace before the XML declaration', function () {
      const input = '  \n  <?xml version="1.0"?><root></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      expect(trimBeforeXmlDeclaration(input)).to.equal(expected);
    });
  });

  describe('fixMultipleXmlDeclarations', function () {
    it('should remove additional XML declarations', function () {
      const input = '<?xml version="1.0"?><root><?xml version="1.1"?></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      expect(fixMultipleXmlDeclarations(input)).to.equal(expected);
    });

    it('should handle multiple additional declarations', function () {
      const input =
        '<?xml version="1.0"?><root><?xml version="1.1"?><?xml version="1.2"?></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      expect(fixMultipleXmlDeclarations(input)).to.equal(expected);
    });

    it('should return the original string if there is only one XML declaration', function () {
      const input = '<?xml version="1.0"?><root></root>';
      expect(fixMultipleXmlDeclarations(input)).to.equal(input);
    });

    it('should return the original string if there is no XML declaration', function () {
      const input = '<root></root>';
      expect(fixMultipleXmlDeclarations(input)).to.equal(input);
    });

    it('should work with Buffer inputs', function () {
      const buffer = Buffer.from(
        '<?xml version="1.0"?><root><?xml version="1.1"?></root>',
        'utf8',
      );
      const expected = '<?xml version="1.0"?><root></root>';
      expect(fixMultipleXmlDeclarations(buffer)).to.equal(expected);
    });
  });

  describe('isValidXml', function () {
    it('should return true for valid XML', function () {
      expect(isValidXml('<?xml version="1.0"?><root></root>')).to.be.true;
      expect(isValidXml('<root></root>')).to.be.true;
      expect(isValidXml('<root/>')).to.be.true;
    });

    it('should return false for invalid XML', function () {
      expect(isValidXml('')).to.be.false;
      expect(isValidXml('  ')).to.be.false;
      expect(isValidXml('not xml')).to.be.false;
    });

    it('should work with Buffer inputs', function () {
      const validBuffer = Buffer.from(
        '<?xml version="1.0"?><root></root>',
        'utf8',
      );
      const invalidBuffer = Buffer.from('not xml', 'utf8');

      expect(isValidXml(validBuffer)).to.be.true;
      expect(isValidXml(invalidBuffer)).to.be.false;
    });

    it('should handle XML with only a declaration', function () {
      expect(isValidXml('<?xml version="1.0"?>')).to.be.true;
    });
  });

  describe('escapeXml', function () {
    it('should escape special XML characters', function () {
      expect(escapeXml('<')).to.equal('&lt;');
      expect(escapeXml('>')).to.equal('&gt;');
      expect(escapeXml('&')).to.equal('&amp;');
      expect(escapeXml('"')).to.equal('&quot;');
      expect(escapeXml('\'')).to.equal('&apos;');
    });

    it('should escape multiple special characters in a string', function () {
      expect(escapeXml('<tag attr="value" & more=\'stuff\'>')).to.equal(
        '&lt;tag attr=&quot;value&quot; &amp; more=&apos;stuff&apos;&gt;',
      );
    });

    it('should not modify regular characters', function () {
      expect(escapeXml('normal text')).to.equal('normal text');
      expect(escapeXml('123')).to.equal('123');
    });

    it('should handle empty strings', function () {
      expect(escapeXml('')).to.equal('');
    });
  });


  describe('isXmlPlistContent', function () {
    it('should return true for content with XML declaration', function () {
      expect(isXmlPlistContent('<?xml version="1.0"?><root></root>')).to.be
        .true;
    });

    it('should return true for content with plist tag', function () {
      expect(isXmlPlistContent('<plist><dict></dict></plist>')).to.be.true;
    });

    it('should return false for content without XML declaration or plist tag', function () {
      expect(isXmlPlistContent('<root></root>')).to.be.false;
      expect(isXmlPlistContent('not xml')).to.be.false;
    });

    it('should work with Buffer inputs', function () {
      const xmlBuffer = Buffer.from(
        '<?xml version="1.0"?><root></root>',
        'utf8',
      );
      const plistBuffer = Buffer.from('<plist><dict></dict></plist>', 'utf8');
      const nonXmlBuffer = Buffer.from('not xml', 'utf8');

      expect(isXmlPlistContent(xmlBuffer)).to.be.true;
      expect(isXmlPlistContent(plistBuffer)).to.be.true;
      expect(isXmlPlistContent(nonXmlBuffer)).to.be.false;
    });
  });

  describe('Integration Tests', function () {
    it('should clean and fix XML with multiple issues', function () {
      // XML with multiple issues: content before declaration, multiple declarations, and replacement character
      const problematicXml =
        'garbage data<?xml version="1.0"?><?xml version="1.1"?><plist><dict><key>test</key><string>val�ue</string></dict></plist>';

      // Apply the cleaning functions in sequence
      let cleanedXml = trimBeforeXmlDeclaration(problematicXml);
      cleanedXml = fixMultipleXmlDeclarations(cleanedXml);

      // Verify the result
      expect(cleanedXml).to.include('<?xml version="1.0"?>');
      expect(cleanedXml).not.to.include('garbage data');
      expect(cleanedXml).not.to.include('<?xml version="1.1"?>');
      expect(cleanedXml).to.include('<plist>');

      // Verify that the replacement character is still there (it's handled by the parser, not these utils)
      expect(hasUnicodeReplacementCharacter(cleanedXml)).to.be.true;
    });
  });
});
