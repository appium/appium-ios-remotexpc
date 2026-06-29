import { expect } from 'chai';
import os from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
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

    expect(result.endsWith('_deadbeef.txt')).to.equal(true);
    expect(Buffer.byteLength(result, 'utf8')).to.be.at.most(255);
    expect(result).to.include('deadbeef');
  });

  it('should preserve the suffix when there is no extension', function () {
    const longBase = 'b'.repeat(300);
    const result = appendUniqueSuffix(longBase, 'cafebabe');

    expect(result.endsWith('_cafebabe')).to.equal(true);
    expect(Buffer.byteLength(result, 'utf8')).to.be.at.most(255);
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
      expect(sanitizeLocalFilename('report>file.txt')).to.equal(
        'reportfile.txt',
      );
      expect(sanitizeLocalFilename('a/b\\c:d*e?f"g|h')).to.equal('abcdefgh');
    });

    it('should reject reserved device names', function () {
      expect(sanitizeLocalFilename('CON')).to.equal(EMPTY_SANITIZED_FILENAME);
      expect(sanitizeLocalFilename('com1.log')).to.equal(
        EMPTY_SANITIZED_FILENAME,
      );
    });

    it('should strip trailing dots and spaces', function () {
      expect(sanitizeLocalFilename('name. ')).to.equal('name');
    });

    it('should return a fallback for empty results', function () {
      expect(sanitizeLocalFilename('..')).to.equal(EMPTY_SANITIZED_FILENAME);
    });
  });

  describe('darwin', function () {
    beforeEach(function () {
      stubPlatform('darwin');
    });

    it('should remove path separators and colons', function () {
      expect(sanitizeLocalFilename('folder:name')).to.equal('foldername');
      expect(sanitizeLocalFilename('nested/name')).to.equal('nestedname');
    });

    it('should keep characters that are valid on macOS but not Windows', function () {
      expect(sanitizeLocalFilename('bad>char')).to.equal('bad>char');
      expect(sanitizeLocalFilename('keeps*star')).to.equal('keeps*star');
    });

    it('should return a fallback for reserved dot names', function () {
      expect(sanitizeLocalFilename('..')).to.equal(EMPTY_SANITIZED_FILENAME);
    });
  });

  describe('linux', function () {
    beforeEach(function () {
      stubPlatform('linux');
    });

    it('should only strip path separators and control chars', function () {
      expect(sanitizeLocalFilename('keeps>chars')).to.equal('keeps>chars');
      expect(sanitizeLocalFilename('nested/name')).to.equal('nestedname');
      expect(sanitizeLocalFilename('also:colon')).to.equal('also:colon');
    });

    it('should return a fallback for reserved dot names', function () {
      expect(sanitizeLocalFilename('..')).to.equal(EMPTY_SANITIZED_FILENAME);
    });
  });
});
