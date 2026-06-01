import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import type { ZipConduitStreamStats } from '../../src/services/ios/zipconduit/index.js';

const log = getLogger('ZipConduit.UploadComparison.test');

const MIB = 1024 * 1024;

/**
 * Compare raw upload throughput: zip_conduit stream vs AFC push of the IPA file.
 *
 * Required:
 * - UDID
 * - TEST_IPA_PATH
 * - Tunnel registry running (strongbox port must match registry, e.g. 42314)
 *
 * Optional:
 * - INSTALL_PERF_SKIP_AFC=1
 * - INSTALL_PERF_SKIP_ZIPCONDUIT=1
 *
 * Example:
 *   UDID=... TEST_IPA_PATH=/path/App.ipa npm run test:zipconduit-upload-compare
 */
describe('Upload comparison: zip_conduit stream vs AFC', function () {
  this.timeout(25 * 60 * 1000);

  const udid = process.env.UDID || '';
  const testIpaPath = process.env.TEST_IPA_PATH || '';
  const skipAfc = process.env.INSTALL_PERF_SKIP_AFC === '1';
  const skipZipConduit = process.env.INSTALL_PERF_SKIP_ZIPCONDUIT === '1';

  before(function () {
    if (!udid || !testIpaPath) {
      log.warn('Skipping: set UDID and TEST_IPA_PATH');
      this.skip();
    }
  });

  it('reports zip_conduit stream vs AFC push throughput', async function () {
    const ipaStat = await fs.stat(testIpaPath);
    const ipaMiB = ipaStat.size / MIB;

    let zipStats: ZipConduitStreamStats | undefined;
    let afcMs: number | undefined;

    if (!skipZipConduit) {
      const zipConduit = await Services.startZipConduitService(udid);
      try {
        const result = await zipConduit.install(testIpaPath, {
          streamOnly: true,
        });
        if (!result) {
          throw new Error('zip_conduit streamOnly did not return stats');
        }
        zipStats = result;
        logThroughput(
          'zip_conduit stream',
          zipStats.payloadBytes,
          zipStats.streamMs,
        );
      } finally {
        zipConduit.close();
      }
    }

    if (!skipAfc) {
      const afc = await Services.startAfcService(udid);
      const remotePath = `/Downloads/zipconduit_upload_compare_${Date.now()}.ipa`;
      try {
        const startedAt = performance.now();
        await afc.push(testIpaPath, remotePath);
        afcMs = performance.now() - startedAt;
        const remoteStat = await afc.stat(remotePath);
        expect(Number(remoteStat.st_size)).to.equal(ipaStat.size);
        logThroughput('AFC push (compressed IPA on disk)', ipaStat.size, afcMs);
        await afc.rm(remotePath, true);
      } finally {
        afc.close();
      }
    }

    log.info(
      `IPA on disk: ${ipaMiB.toFixed(2)} MiB (${path.basename(testIpaPath)})`,
    );

    if (zipStats && afcMs !== undefined) {
      const zipPayloadMiB = zipStats.payloadBytes / MIB;
      const zipMibPerSec =
        zipStats.payloadBytes / MIB / (zipStats.streamMs / 1000);
      const afcMibPerSec = ipaStat.size / MIB / (afcMs / 1000);
      log.info(
        `Summary: zip_conduit payload ${zipPayloadMiB.toFixed(2)} MiB uncompressed ` +
          `at ${zipMibPerSec.toFixed(2)} MiB/s vs AFC ${ipaMiB.toFixed(2)} MiB at ${afcMibPerSec.toFixed(2)} MiB/s`,
      );
      if (zipMibPerSec > afcMibPerSec) {
        log.info(
          `zip_conduit stream is ${(zipMibPerSec / afcMibPerSec).toFixed(2)}x faster than AFC push`,
        );
      } else {
        log.info(
          `AFC push is ${(afcMibPerSec / zipMibPerSec).toFixed(2)}x faster than zip_conduit stream`,
        );
      }
    }

    if (!skipZipConduit) {
      expect(zipStats).to.exist;
    }
    if (!skipAfc) {
      expect(afcMs).to.be.a('number');
    }
  });
});

function logThroughput(label: string, bytes: number, ms: number): void {
  const mibPerSec = bytes / MIB / (ms / 1000);
  const mbitPerSec = (bytes * 8) / (ms / 1000) / 1_000_000;
  log.info(
    `${label}: ${(ms / 1000).toFixed(2)}s | ${(bytes / MIB).toFixed(2)} MiB | ` +
      `${mibPerSec.toFixed(2)} MiB/s (${mbitPerSec.toFixed(1)} Mbit/s)`,
  );
}
