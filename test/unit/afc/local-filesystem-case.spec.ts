import assert from 'node:assert/strict';
import os from 'node:os';
import {afterEach, describe, it} from 'node:test';

import {
  type DiskutilInfoPlist,
  clearCaseSensitivityCache,
  isCaseSensitiveDirectory,
  parseDiskutilInfoPlist,
} from '../../../src/services/ios/afc/local-filesystem-case.js';

describe('parseDiskutilInfoPlist', function () {
  it('should detect case-insensitive APFS', function () {
    const info: DiskutilInfoPlist = {
      FilesystemName: 'APFS',
      FilesystemUserVisibleName: 'APFS',
      FilesystemType: 'apfs',
    };
    assert.strictEqual(parseDiskutilInfoPlist(info), false);
  });

  it('should detect case-sensitive APFS', function () {
    const info: DiskutilInfoPlist = {
      FilesystemName: 'Case-sensitive APFS',
      FilesystemUserVisibleName: 'APFS (Case-sensitive)',
      FilesystemType: 'apfs',
    };
    assert.strictEqual(parseDiskutilInfoPlist(info), true);
  });

  it('should detect case-sensitive HFS+', function () {
    const info: DiskutilInfoPlist = {
      FilesystemName: 'HFS+ (Case-sensitive)',
      FilesystemUserVisibleName: 'Mac OS Extended (Case-sensitive, Journaled)',
    };
    assert.strictEqual(parseDiskutilInfoPlist(info), true);
  });

  it('should throw when diskutil plist omits case semantics', function () {
    assert.throws(
      () => parseDiskutilInfoPlist({VolumeName: 'Mystery'}),
      (err: any) => err.message.includes('diskutil info plist did not include recognizable case-sensitivity details'),
    );
  });

  it('should honor explicit case-sensitive plist fields when present', function () {
    assert.strictEqual(parseDiskutilInfoPlist({'Name (Case-Sensitive)': 'Yes'}), true);
    assert.strictEqual(parseDiskutilInfoPlist({'Name (Case-Sensitive)': 'No'}), false);
  });
});

describe('isCaseSensitiveDirectory', function () {
  afterEach(function () {
    clearCaseSensitivityCache();
  });

  (os.platform() === 'darwin' ? it : it.skip)(
    'should match diskutil info -plist for the tmpdir volume on macOS',
    async function () {
      const detected = await isCaseSensitiveDirectory(os.tmpdir());
      assert.ok(typeof detected === 'boolean');
    },
  );

  (os.platform() === 'darwin' ? it : it.skip)(
    'should return a stable cached result for the same directory',
    async function () {
      const dir = os.tmpdir();
      const first = await isCaseSensitiveDirectory(dir);
      const second = await isCaseSensitiveDirectory(dir);
      assert.strictEqual(second, first);
    },
  );
});
