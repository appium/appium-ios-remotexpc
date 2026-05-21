import { expect } from 'chai';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';

import { PullLocalNameAllocator } from '../../../src/services/ios/afc/pull-local-name-allocator.js';
import { withUniqueSuffix } from '../../../src/services/ios/afc/sanitize-local-filename.js';

describe('withUniqueSuffix', function () {
  it('should insert the suffix before the extension', function () {
    expect(withUniqueSuffix('reportfile.txt', 'a1b2c3d4')).to.equal(
      'reportfile_a1b2c3d4.txt',
    );
  });

  it('should append the suffix when there is no extension', function () {
    expect(withUniqueSuffix('reportfile', 'a1b2c3d4')).to.equal(
      'reportfile_a1b2c3d4',
    );
  });
});

describe('PullLocalNameAllocator', function () {
  let platformStub: sinon.SinonStub<[], NodeJS.Platform>;
  const parentDir = '/tmp/pull-test';

  afterEach(function () {
    platformStub?.restore();
  });

  function stubPlatform(platform: NodeJS.Platform): void {
    platformStub = sinon.stub(os, 'platform').returns(platform);
  }

  it('should return the sanitized name when there is no clash', async function () {
    stubPlatform('linux');
    const exists = sinon.stub().resolves(false);
    const allocator = new PullLocalNameAllocator(exists, false);

    const name = await allocator.allocate(parentDir, 'keeps>chars');

    expect(name).to.equal('keeps>chars');
    expect(exists.calledOnce).to.equal(true);
    expect(exists.firstCall.args[0]).to.equal(
      path.join(parentDir, 'keeps>chars'),
    );
  });

  it('should add a suffix when two remote names sanitize to the same local name', async function () {
    stubPlatform('win32');
    const exists = sinon.stub().resolves(false);
    const allocator = new PullLocalNameAllocator(exists, true);

    const first = await allocator.allocate(parentDir, 'file?');
    const second = await allocator.allocate(parentDir, '*file*');

    expect(first).to.equal('file');
    expect(second).to.match(/^file_[0-9a-f]{8}$/);
    expect(second).to.not.equal(first);
  });

  it('should add a suffix when the sanitized name already exists on disk and overwrite is false', async function () {
    stubPlatform('win32');
    const exists = sinon
      .stub()
      .callsFake(
        async (localPath: string) =>
          path.basename(localPath) === 'reportfile.txt',
      );
    const allocator = new PullLocalNameAllocator(exists, false);

    const name = await allocator.allocate(parentDir, 'report>file.txt');

    expect(name).to.match(/^reportfile_[0-9a-f]{8}\.txt$/);
  });

  it('should reuse the sanitized name when overwrite is true and the path exists on disk', async function () {
    stubPlatform('win32');
    const exists = sinon.stub().resolves(true);
    const allocator = new PullLocalNameAllocator(exists, true);

    const name = await allocator.allocate(parentDir, 'report>file.txt');

    expect(name).to.equal('reportfile.txt');
    expect(exists.called).to.equal(false);
  });

  it('should treat names as case-insensitive when the volume is case-insensitive', async function () {
    const exists = sinon.stub().resolves(false);
    const allocator = new PullLocalNameAllocator(
      exists,
      true,
      async () => false,
    );

    await allocator.allocate(parentDir, 'File');
    const second = await allocator.allocate(parentDir, 'file');

    expect(second).to.match(/^file_[0-9a-f]{8}$/);
  });

  it('should allow differing case when the volume is case-sensitive', async function () {
    const exists = sinon.stub().resolves(false);
    const allocator = new PullLocalNameAllocator(
      exists,
      true,
      async () => true,
    );

    const first = await allocator.allocate(parentDir, 'File');
    const second = await allocator.allocate(parentDir, 'file');

    expect(first).to.equal('File');
    expect(second).to.equal('file');
  });
});
