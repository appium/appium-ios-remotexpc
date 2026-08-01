import assert from 'node:assert/strict';
import os from 'node:os';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  EMPTY_SANITIZED_FILENAME,
  appendUniqueSuffix,
  sanitizeLocalFilename,
} from '../../../src/services/ios/afc/sanitize-local-filename.js';

describe('appendUniqueSuffix', function () {
  it('should preserve the suffix on long names by truncating the base first', function () {
    const longBase = 'a'.repeat(300);
    const result = appendUniqueSuffix(`${longBase}.txt`, 'deadbeef');

    assert.strictEqual(result.endsWith('_deadbeef.txt'), true);
    assert.ok(Buffer.byteLength(result, 'utf8') <= 255);
    assert.ok(result.includes('deadbeef'));
  });

  it('should preserve the suffix when there is no extension', function () {
    const longBase = 'b'.repeat(300);
    const result = appendUniqueSuffix(longBase, 'cafebabe');

    assert.strictEqual(result.endsWith('_cafebabe'), true);
    assert.ok(Buffer.byteLength(result, 'utf8') <= 255);
  });
});

describe('sanitizeLocalFilename', function () {
  let platformStub: sinon.SinonStub<[], NodeJS.Platform>;

  afterEach(function () {
    platformStub?.restore();
  });

  function stubPlatform(platform: NodeJS.Platform): void {
    platformStub = sinon.stub(os, 'platform').returns(platform);
  }

  describe('win32', function () {
    beforeEach(function () {
      stubPlatform('win32');
    });

    it('should remove Windows-illegal characters', function () {
      assert.strictEqual(sanitizeLocalFilename('report>file.txt'), 'reportfile.txt');
      assert.strictEqual(sanitizeLocalFilename('a/b\\c:d*e?f"g|h'), 'abcdefgh');
    });

    it('should reject reserved device names', function () {
      assert.strictEqual(sanitizeLocalFilename('CON'), EMPTY_SANITIZED_FILENAME);
      assert.strictEqual(sanitizeLocalFilename('com1.log'), EMPTY_SANITIZED_FILENAME);
    });

    it('should strip trailing dots and spaces', function () {
      assert.strictEqual(sanitizeLocalFilename('name. '), 'name');
    });

    it('should return a fallback for empty results', function () {
      assert.strictEqual(sanitizeLocalFilename('..'), EMPTY_SANITIZED_FILENAME);
    });
  });

  describe('darwin', function () {
    beforeEach(function () {
      stubPlatform('darwin');
    });

    it('should remove path separators and colons', function () {
      assert.strictEqual(sanitizeLocalFilename('folder:name'), 'foldername');
      assert.strictEqual(sanitizeLocalFilename('nested/name'), 'nestedname');
    });

    it('should keep characters that are valid on macOS but not Windows', function () {
      assert.strictEqual(sanitizeLocalFilename('bad>char'), 'bad>char');
      assert.strictEqual(sanitizeLocalFilename('keeps*star'), 'keeps*star');
    });

    it('should return a fallback for reserved dot names', function () {
      assert.strictEqual(sanitizeLocalFilename('..'), EMPTY_SANITIZED_FILENAME);
    });
  });

  describe('linux', function () {
    beforeEach(function () {
      stubPlatform('linux');
    });

    it('should only strip path separators and control chars', function () {
      assert.strictEqual(sanitizeLocalFilename('keeps>chars'), 'keeps>chars');
      assert.strictEqual(sanitizeLocalFilename('nested/name'), 'nestedname');
      assert.strictEqual(sanitizeLocalFilename('also:colon'), 'also:colon');
    });

    it('should return a fallback for reserved dot names', function () {
      assert.strictEqual(sanitizeLocalFilename('..'), EMPTY_SANITIZED_FILENAME);
    });
  });
});
