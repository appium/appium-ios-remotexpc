import { expect } from 'chai';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import type { InstallationProxyService } from '../../src/services/ios/installation-proxy/index.js';
import type ZipConduitService from '../../src/services/ios/zipconduit/index.js';
import { requireDeviceUdid } from './helpers/device.js';

const log = getLogger('ZipConduit.Install.test');

/**
 * Integration test for fast IPA install via streaming zip_conduit.
 *
 * Required environment variables:
 * - UDID: Device UDID
 * - TEST_IPA_PATH: Path to test IPA file
 * - TEST_BUNDLE_ID: Bundle ID of the test app
 *
 * Example:
 * UDID=... TEST_IPA_PATH=./App.ipa TEST_BUNDLE_ID=com.example.app npm run test:zipconduit-install
 */
describe('ZipConduit Install', { timeout: 600000 }, function () {
  let zipConduitService: ZipConduitService;
  let installationProxyService: InstallationProxyService;

  const udid = requireDeviceUdid();
  const testIpaPath = process.env.TEST_IPA_PATH || '';
  const testBundleId = process.env.TEST_BUNDLE_ID || '';

  before(async function () {
    if (!testIpaPath || !testBundleId) {
      throw new Error(
        'Skipping ZipConduit install test: TEST_IPA_PATH and TEST_BUNDLE_ID must be set',
      );
    }

    zipConduitService = await Services.startZipConduitService(udid);
    installationProxyService =
      await Services.startInstallationProxyService(udid);
  });

  after(async function () {
    try {
      if (installationProxyService) {
        const apps = await installationProxyService.lookup([testBundleId]);
        if (apps[testBundleId]) {
          await installationProxyService.uninstall(testBundleId);
        }
      }
    } catch (error) {
      log.warn('Error cleaning up installed app:', error);
    }
    try {
      zipConduitService?.close();
    } catch (error) {
      log.warn('Error closing ZipConduit service:', error);
    }
    try {
      installationProxyService?.close();
    } catch (error) {
      log.warn('Error closing Installation Proxy:', error);
    }
  });

  it('should install IPA via streaming zip_conduit', async function () {
    const appsBefore = await installationProxyService.lookup([testBundleId]);
    if (appsBefore[testBundleId]) {
      await installationProxyService.uninstall(testBundleId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const startedAt = Date.now();
    const progressUpdates: Array<{ percent: number; status: string }> = [];

    log.info(`Installing ${testIpaPath} via zip_conduit`);
    await zipConduitService.install(testIpaPath, {
      progress: ({ percent, status }) => {
        progressUpdates.push({ percent, status });
        log.info(`Install progress: ${percent}% (${status})`);
      },
    });

    const elapsedMs = Date.now() - startedAt;
    log.info(
      `ZipConduit install finished in ${(elapsedMs / 1000).toFixed(2)}s (${progressUpdates.length} updates)`,
    );

    await new Promise((resolve) => setTimeout(resolve, 5000));

    const appsAfter = await installationProxyService.lookup([testBundleId]);
    expect(appsAfter[testBundleId]).to.exist;
    expect(progressUpdates.length).to.be.greaterThan(0);
    expect(path.basename(testIpaPath)).to.match(/\.ipa$/i);
  });
});
