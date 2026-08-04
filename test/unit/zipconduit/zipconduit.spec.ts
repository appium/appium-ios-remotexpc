import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ZIP_LOCAL_FILE_HEADER_SIGNATURE} from '../../../src/services/ios/zipconduit/constants.js';
import {
  SIGNING_ERROR,
  createInitTransfer,
  createMetaInfPlist,
  evaluateProgress,
} from '../../../src/services/ios/zipconduit/plists.js';
import {createMetaInfBytes, transferDirectory} from '../../../src/services/ios/zipconduit/zip-utils.js';

describe('zipconduit/plists', function () {
  it('creates InitTransfer matching Xcode-style options', function () {
    const init = createInitTransfer('/tmp/MyApp.ipa');
    assert.strictEqual(init.MediaSubdir, 'PublicStaging/MyApp.ipa');
    assert.strictEqual(init.InstallTransferredDirectory, 1);
    assert.strictEqual(init.InstallOptionsDictionary.InstallDeltaTypeKey, 'InstallDeltaTypeSparseIPAFiles');
  });

  it('evaluates DataComplete status', function () {
    const result = evaluateProgress({Status: 'DataComplete'});
    assert.strictEqual(result.done, true);
    assert.strictEqual(result.percent, 100);
  });

  it('evaluates InstallProgressDict updates', function () {
    const result = evaluateProgress({
      InstallProgressDict: {
        PercentComplete: 42,
        Status: 'Installing',
      },
    });
    assert.strictEqual(result.done, false);
    assert.strictEqual(result.percent, 42);
    assert.strictEqual(result.status, 'Installing');
  });

  it('throws on signing errors', function () {
    assert.throws(
      () =>
        evaluateProgress({
          InstallProgressDict: {
            Error: SIGNING_ERROR,
            ErrorDescription: 'invalid signature',
          },
        }),
      /not properly signed/,
    );
  });
});

describe('zipconduit/zip-utils', function () {
  it('builds metadata plist bytes', function () {
    const metadata = createMetaInfPlist(10, 12345);
    assert.strictEqual(metadata.RecordCount, 12);
    assert.strictEqual(metadata.TotalUncompressedBytes, 12345);

    const bytes = createMetaInfBytes(10, 12345);
    assert.ok(bytes.length > 0);
    assert.ok(bytes.toString('utf8').includes('RecordCount'));
  });

  it('writes a directory local header', async function () {
    const chunks: Buffer[] = [];
    const socket = {
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      write(data: Buffer, cb?: (err?: Error | null) => void) {
        chunks.push(data);
        // eslint-disable-next-line promise/prefer-await-to-callbacks
        cb?.(null);
        return true;
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
      off() {
        return this;
      },
    } as any;

    await transferDirectory(socket, 'Payload/');
    const payload = Buffer.concat(chunks);
    assert.strictEqual(payload.readUInt32LE(0), ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    assert.ok(payload.toString('utf8').includes('Payload/'));
  });
});
