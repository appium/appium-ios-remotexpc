import { ZIP_LOCAL_FILE_HEADER_SIGNATURE } from '../../../src/services/ios/zipconduit/constants.js';
import {
  SIGNING_ERROR,
  createInitTransfer,
  createMetaInfPlist,
  evaluateProgress,
} from '../../../src/services/ios/zipconduit/plists.js';
import {
  createMetaInfBytes,
  transferDirectory,
} from '../../../src/services/ios/zipconduit/zip-utils.js';

describe('zipconduit/plists', function () {
  it('creates InitTransfer matching Xcode-style options', function () {
    const init = createInitTransfer('/tmp/MyApp.ipa');
    expect(init.MediaSubdir).to.equal('PublicStaging/MyApp.ipa');
    expect(init.InstallTransferredDirectory).to.equal(1);
    expect(init.InstallOptionsDictionary.InstallDeltaTypeKey).to.equal(
      'InstallDeltaTypeSparseIPAFiles',
    );
  });

  it('evaluates DataComplete status', function () {
    const result = evaluateProgress({ Status: 'DataComplete' });
    expect(result.done).to.be.true;
    expect(result.percent).to.equal(100);
  });

  it('evaluates InstallProgressDict updates', function () {
    const result = evaluateProgress({
      InstallProgressDict: {
        PercentComplete: 42,
        Status: 'Installing',
      },
    });
    expect(result.done).to.be.false;
    expect(result.percent).to.equal(42);
    expect(result.status).to.equal('Installing');
  });

  it('throws on signing errors', function () {
    expect(() =>
      evaluateProgress({
        InstallProgressDict: {
          Error: SIGNING_ERROR,
          ErrorDescription: 'invalid signature',
        },
      }),
    ).to.throw(/not properly signed/);
  });
});

describe('zipconduit/zip-utils', function () {
  it('builds metadata plist bytes', function () {
    const metadata = createMetaInfPlist(10, 12345);
    expect(metadata.RecordCount).to.equal(12);
    expect(metadata.TotalUncompressedBytes).to.equal(12345);

    const bytes = createMetaInfBytes(10, 12345);
    expect(bytes.length).to.be.greaterThan(0);
    expect(bytes.toString('utf8')).to.include('RecordCount');
  });

  it('writes a directory local header', async function () {
    const chunks: Buffer[] = [];
    const socket = {
      write(data: Buffer, cb?: (err?: Error | null) => void) {
        chunks.push(data);
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
    expect(payload.readUInt32LE(0)).to.equal(ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    expect(payload.toString('utf8')).to.include('Payload/');
  });
});
