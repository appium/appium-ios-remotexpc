import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import { InstallationProxyService } from '../../src/services/ios/installation-proxy/index.js';
import ZipConduitService from '../../src/services/ios/zipconduit/index.js';

const log = getLogger('InstallPerformanceComparison.test');

const MIB = 1024 * 1024;

/**
 * Compare end-to-end install time: AFC upload + installation_proxy vs zip_conduit.
 *
 * Required:
 * - UDID
 * - Tunnel registry running
 *
 * Optional:
 * - TEST_IPA_PATH (default: none — must be set)
 * - TEST_BUNDLE_ID
 * - INSTALL_PERF_SKIP_AFC=1 | INSTALL_PERF_SKIP_ZIPCONDUIT=1
 *
 * Example:
 *   UDID=00008030-... \
 *   TEST_IPA_PATH=/path/to/App.ipa \
 *   TEST_BUNDLE_ID=org.example.app \
 *   npm run test:install-perf-compare
 */
describe('Install performance: zip_conduit vs AFC', function () {
  this.timeout(20 * 60 * 1000);

  const udid = process.env.UDID || '';
  const testIpaPath = process.env.TEST_IPA_PATH || '';
  const testBundleId = process.env.TEST_BUNDLE_ID || '';
  const skipAfc = process.env.INSTALL_PERF_SKIP_AFC === '1';
  const skipZipConduit = process.env.INSTALL_PERF_SKIP_ZIPCONDUIT === '1';

  before(function () {
    if (!udid || !testIpaPath || !testBundleId) {
      log.warn('Skipping: set UDID, TEST_IPA_PATH, and TEST_BUNDLE_ID');
      this.skip();
    }
  });

  it('reports AFC vs zip_conduit install timings', async function () {
    const ipaStat = await fs.stat(testIpaPath);
    const ipaMiB = ipaStat.size / MIB;
    const remoteIpaPath = `/PublicStaging/${path.basename(testIpaPath)}`;

    log.info(
      `IPA: ${testIpaPath} (${ipaMiB.toFixed(2)} MiB), bundle: ${testBundleId}`,
    );

    const results: Record<string, number | string> = {};

    if (!skipZipConduit) {
      await uninstallApp(udid, testBundleId);
      const zip = await measureZipConduitInstall(udid, testIpaPath);
      results.zipConduitTotalMs = zip.totalMs;
      results.zipConduitMiBps = (ipaMiB / (zip.totalMs / 1000)).toFixed(2);
      log.info(
        `zip_conduit: ${formatSeconds(zip.totalMs)} total (${results.zipConduitMiBps} MiB/s effective)`,
      );
      await uninstallApp(udid, testBundleId);
    }

    if (!skipAfc) {
      await uninstallApp(udid, testBundleId);
      const afc = await measureAfcInstall(
        udid,
        testIpaPath,
        remoteIpaPath,
        testBundleId,
      );
      results.afcPushMs = afc.pushMs;
      results.afcInstallMs = afc.installMs;
      results.afcTotalMs = afc.totalMs;
      results.afcPushMiBps = (ipaMiB / (afc.pushMs / 1000)).toFixed(2);
      results.afcTotalMiBps = (ipaMiB / (afc.totalMs / 1000)).toFixed(2);
      log.info(
        `AFC push: ${formatSeconds(afc.pushMs)} (${results.afcPushMiBps} MiB/s)`,
      );
      log.info(`installation_proxy install: ${formatSeconds(afc.installMs)}`);
      log.info(
        `AFC + install total: ${formatSeconds(afc.totalMs)} (${results.afcTotalMiBps} MiB/s effective)`,
      );
      await cleanupAfcIpa(udid, remoteIpaPath);
    }

    if (
      typeof results.zipConduitTotalMs === 'number' &&
      typeof results.afcTotalMs === 'number'
    ) {
      const ratio =
        (results.afcTotalMs as number) / (results.zipConduitTotalMs as number);
      if (ratio >= 1) {
        log.info(
          `Summary: zip_conduit total is ${ratio.toFixed(2)}x faster than AFC+install`,
        );
      } else {
        log.info(
          `Summary: AFC+install is ${(1 / ratio).toFixed(2)}x faster than zip_conduit total`,
        );
      }
    }

    log.info(`Results: ${JSON.stringify(results, null, 2)}`);
    expect(results).to.not.be.empty;
  });
});

async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  const proxy = await Services.startInstallationProxyService(udid);
  try {
    const apps = await proxy.lookup([bundleId]);
    if (apps[bundleId]) {
      log.info(`Uninstalling ${bundleId} before next run...`);
      await proxy.uninstall(bundleId);
      await delay(3000);
    }
  } finally {
    proxy.close();
  }
}

async function measureZipConduitInstall(
  udid: string,
  ipaPath: string,
): Promise<{ totalMs: number }> {
  const zipConduit = await Services.startZipConduitService(udid);
  try {
    const start = performance.now();
    await zipConduit.install(ipaPath, {
      progress: ({ percent, status }) => {
        log.info(`zip_conduit progress: ${percent}% (${status})`);
      },
    });
    return { totalMs: performance.now() - start };
  } finally {
    zipConduit.close();
  }
}

async function measureAfcInstall(
  udid: string,
  localIpaPath: string,
  remoteIpaPath: string,
  bundleId: string,
): Promise<{ pushMs: number; installMs: number; totalMs: number }> {
  const totalStart = performance.now();
  const afc = await Services.startAfcService(udid);
  let pushMs = 0;
  try {
    try {
      await afc.mkdir('/PublicStaging');
    } catch {
      // exists
    }
    const pushStart = performance.now();
    await afc.push(localIpaPath, remoteIpaPath);
    pushMs = performance.now() - pushStart;
  } finally {
    afc.close();
  }

  const proxy = await Services.startInstallationProxyService(udid);
  let installMs = 0;
  try {
    const installStart = performance.now();
    await proxy.install(remoteIpaPath, {}, (percent, status) => {
      log.info(`installation_proxy progress: ${percent}% (${status})`);
    });
    installMs = performance.now() - installStart;

    const apps = await proxy.lookup([bundleId]);
    expect(apps[bundleId]).to.exist;
  } finally {
    proxy.close();
  }

  return {
    pushMs,
    installMs,
    totalMs: performance.now() - totalStart,
  };
}

async function cleanupAfcIpa(
  udid: string,
  remoteIpaPath: string,
): Promise<void> {
  const afc = await Services.startAfcService(udid);
  try {
    if (await afc.exists(remoteIpaPath)) {
      await afc.rm(remoteIpaPath, true);
    }
  } finally {
    afc.close();
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
