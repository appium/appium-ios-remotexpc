import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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
      assert.strictEqual(ensureString(input), input);
    });

    it('should convert a Buffer to a string', function () {
      const buffer = Buffer.from('test buffer');
      assert.strictEqual(ensureString(buffer), 'test buffer');
    });

    it('should handle empty inputs', function () {
      assert.strictEqual(ensureString(''), '');
      assert.strictEqual(ensureString(Buffer.alloc(0)), '');
    });

    it('should handle Unicode characters', function () {
      const unicodeStr = 'こんにちは世界';
      const buffer = Buffer.from(unicodeStr, 'utf8');
      assert.strictEqual(ensureString(buffer), unicodeStr);
    });
  });

  describe('hasUnicodeReplacementCharacter', function () {
    it('should return true if the string contains replacement characters', function () {
      assert.strictEqual(hasUnicodeReplacementCharacter('test�string'), true);
      assert.strictEqual(hasUnicodeReplacementCharacter('�at the beginning'), true);
      assert.strictEqual(hasUnicodeReplacementCharacter('at the end�'), true);
      assert.strictEqual(hasUnicodeReplacementCharacter('multiple��chars'), true);
    });

    it('should return false if the string does not contain replacement characters', function () {
      assert.strictEqual(hasUnicodeReplacementCharacter('normal string'), false);
      assert.strictEqual(hasUnicodeReplacementCharacter(''), false);
    });

    it('should work with Buffer inputs', function () {
      const bufferWithReplacement = Buffer.from('test�string', 'utf8');
      const bufferWithoutReplacement = Buffer.from('normal string', 'utf8');

      assert.strictEqual(hasUnicodeReplacementCharacter(bufferWithReplacement), true);
      assert.strictEqual(hasUnicodeReplacementCharacter(bufferWithoutReplacement), false);
    });
  });

  describe('findFirstReplacementCharacter', function () {
    it('should return the index of the first replacement character', function () {
      assert.strictEqual(findFirstReplacementCharacter('test�string'), 4);
      assert.strictEqual(findFirstReplacementCharacter('�at the beginning'), 0);
      assert.strictEqual(findFirstReplacementCharacter('multiple��chars'), 8);
    });

    it('should return -1 if no replacement character is found', function () {
      assert.strictEqual(findFirstReplacementCharacter('normal string'), -1);
      assert.strictEqual(findFirstReplacementCharacter(''), -1);
    });

    it('should work with Buffer inputs', function () {
      const bufferWithReplacement = Buffer.from('test�string', 'utf8');
      assert.strictEqual(findFirstReplacementCharacter(bufferWithReplacement), 4);
    });
  });

  describe('trimBeforeXmlDeclaration', function () {
    it('should remove content before the XML declaration', function () {
      const input = 'garbage data<?xml version="1.0"?><root></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(trimBeforeXmlDeclaration(input), expected);
    });

    it('should return the original string if there is no XML declaration', function () {
      const input = '<root></root>';
      assert.strictEqual(trimBeforeXmlDeclaration(input), input);
    });

    it('should return the original string if the XML declaration is at the beginning', function () {
      const input = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(trimBeforeXmlDeclaration(input), input);
    });

    it('should work with Buffer inputs', function () {
      const buffer = Buffer.from('garbage data<?xml version="1.0"?><root></root>', 'utf8');
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(trimBeforeXmlDeclaration(buffer), expected);
    });

    it('should handle whitespace before the XML declaration', function () {
      const input = '  \n  <?xml version="1.0"?><root></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(trimBeforeXmlDeclaration(input), expected);
    });
  });

  describe('fixMultipleXmlDeclarations', function () {
    it('should remove additional XML declarations', function () {
      const input = '<?xml version="1.0"?><root><?xml version="1.1"?></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(fixMultipleXmlDeclarations(input), expected);
    });

    it('should handle multiple additional declarations', function () {
      const input = '<?xml version="1.0"?><root><?xml version="1.1"?><?xml version="1.2"?></root>';
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(fixMultipleXmlDeclarations(input), expected);
    });

    it('should return the original string if there is only one XML declaration', function () {
      const input = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(fixMultipleXmlDeclarations(input), input);
    });

    it('should return the original string if there is no XML declaration', function () {
      const input = '<root></root>';
      assert.strictEqual(fixMultipleXmlDeclarations(input), input);
    });

    it('should work with Buffer inputs', function () {
      const buffer = Buffer.from('<?xml version="1.0"?><root><?xml version="1.1"?></root>', 'utf8');
      const expected = '<?xml version="1.0"?><root></root>';
      assert.strictEqual(fixMultipleXmlDeclarations(buffer), expected);
    });
  });

  describe('isValidXml', function () {
    it('should return true for valid XML', function () {
      assert.strictEqual(isValidXml('<?xml version="1.0"?><root></root>'), true);
      assert.strictEqual(isValidXml('<root></root>'), true);
      assert.strictEqual(isValidXml('<root/>'), true);
    });

    it('should return false for invalid XML', function () {
      assert.strictEqual(isValidXml(''), false);
      assert.strictEqual(isValidXml('  '), false);
      assert.strictEqual(isValidXml('not xml'), false);
    });

    it('should work with Buffer inputs', function () {
      const validBuffer = Buffer.from('<?xml version="1.0"?><root></root>', 'utf8');
      const invalidBuffer = Buffer.from('not xml', 'utf8');

      assert.strictEqual(isValidXml(validBuffer), true);
      assert.strictEqual(isValidXml(invalidBuffer), false);
    });

    it('should handle XML with only a declaration', function () {
      assert.strictEqual(isValidXml('<?xml version="1.0"?>'), true);
    });
  });

  describe('escapeXml', function () {
    it('should escape special XML characters', function () {
      assert.strictEqual(escapeXml('<'), '&lt;');
      assert.strictEqual(escapeXml('>'), '&gt;');
      assert.strictEqual(escapeXml('&'), '&amp;');
      assert.strictEqual(escapeXml('"'), '&quot;');
      assert.strictEqual(escapeXml("'"), '&apos;');
    });

    it('should escape multiple special characters in a string', function () {
      assert.strictEqual(
        escapeXml('<tag attr="value" & more=\'stuff\'>'),
        '&lt;tag attr=&quot;value&quot; &amp; more=&apos;stuff&apos;&gt;',
      );
    });

    it('should not modify regular characters', function () {
      assert.strictEqual(escapeXml('normal text'), 'normal text');
      assert.strictEqual(escapeXml('123'), '123');
    });

    it('should handle empty strings', function () {
      assert.strictEqual(escapeXml(''), '');
    });
  });

  describe('isXmlPlistContent', function () {
    it('should return true for content with XML declaration', function () {
      assert.strictEqual(isXmlPlistContent('<?xml version="1.0"?><root></root>'), true);
    });

    it('should return true for content with plist tag', function () {
      assert.strictEqual(isXmlPlistContent('<plist><dict></dict></plist>'), true);
    });

    it('should return false for content without XML declaration or plist tag', function () {
      assert.strictEqual(isXmlPlistContent('<root></root>'), false);
      assert.strictEqual(isXmlPlistContent('not xml'), false);
    });

    it('should work with Buffer inputs', function () {
      const xmlBuffer = Buffer.from('<?xml version="1.0"?><root></root>', 'utf8');
      const plistBuffer = Buffer.from('<plist><dict></dict></plist>', 'utf8');
      const nonXmlBuffer = Buffer.from('not xml', 'utf8');

      assert.strictEqual(isXmlPlistContent(xmlBuffer), true);
      assert.strictEqual(isXmlPlistContent(plistBuffer), true);
      assert.strictEqual(isXmlPlistContent(nonXmlBuffer), false);
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
      assert.ok(cleanedXml.includes('<?xml version="1.0"?>'));
      assert.ok(!cleanedXml.includes('garbage data'));
      assert.ok(!cleanedXml.includes('<?xml version="1.1"?>'));
      assert.ok(cleanedXml.includes('<plist>'));

      // Verify that the replacement character is still there (it's handled by the parser, not these utils)
      assert.strictEqual(hasUnicodeReplacementCharacter(cleanedXml), true);
    });
  });
});
