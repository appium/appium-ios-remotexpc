import { expect } from 'chai';
import os from 'node:os';

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
    expect(parseDiskutilInfoPlist(info)).to.equal(false);
  });

  it('should detect case-sensitive APFS', function () {
    const info: DiskutilInfoPlist = {
      FilesystemName: 'Case-sensitive APFS',
      FilesystemUserVisibleName: 'APFS (Case-sensitive)',
      FilesystemType: 'apfs',
    };
    expect(parseDiskutilInfoPlist(info)).to.equal(true);
  });

  it('should detect case-sensitive HFS+', function () {
    const info: DiskutilInfoPlist = {
      FilesystemName: 'HFS+ (Case-sensitive)',
      FilesystemUserVisibleName: 'Mac OS Extended (Case-sensitive, Journaled)',
    };
    expect(parseDiskutilInfoPlist(info)).to.equal(true);
  });

  it('should throw when diskutil plist omits case semantics', function () {
    expect(() => parseDiskutilInfoPlist({ VolumeName: 'Mystery' })).to.throw(
      'diskutil info plist did not include recognizable case-sensitivity details',
    );
  });

  it('should honor explicit case-sensitive plist fields when present', function () {
    expect(parseDiskutilInfoPlist({ 'Name (Case-Sensitive)': 'Yes' })).to.equal(
      true,
    );
    expect(parseDiskutilInfoPlist({ 'Name (Case-Sensitive)': 'No' })).to.equal(
      false,
    );
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
      expect(detected).to.be.a('boolean');
    },
  );

  (os.platform() === 'darwin' ? it : it.skip)(
    'should return a stable cached result for the same directory',
    async function () {
      const dir = os.tmpdir();
      const first = await isCaseSensitiveDirectory(dir);
      const second = await isCaseSensitiveDirectory(dir);
      expect(second).to.equal(first);
    },
  );
});
