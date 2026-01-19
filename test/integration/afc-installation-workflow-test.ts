import { expect } from 'chai';
import path from 'node:path';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import AfcService from '../../src/services/ios/afc/index.js';
import { InstallationProxyService } from '../../src/services/ios/installation-proxy/index.js';

const log = getLogger('AFC-InstallationProxy.Workflow.test');

/**
 * Integration tests for the complete app installation workflow:
 * AFC (file upload) + Installation Proxy (install/uninstall)
 *
 * Required environment variables:
 * - UDID: Device UDID
 * - TEST_IPA_PATH: Path to test IPA file (e.g., /path/to/TestApp_v1.ipa)
 * - TEST_IPA_PATH_2: Path to the second version of the IPA file for upgrade tests (e.g., /path/to/TestApp_v2.ipa)
 * - TEST_BUNDLE_ID: Bundle ID of the test app (e.g., com.example.testapp)
 *
 * Example:
 * UDID=... TEST_IPA_PATH=./v1.ipa TEST_IPA_PATH_2=./v2.ipa TEST_BUNDLE_ID=com.test.app npm run test:installation-workflow
 */
describe('AFC + Installation Proxy Workflow', function () {
  // Installation can take several minutes depending on app size
  this.timeout(300000); // 5 minutes

  let remoteXPC: any;
  let afcService: AfcService;
  let installationProxyService: InstallationProxyService;

  const udid = process.env.UDID || '';
  const testIpaPathV1 = process.env.TEST_IPA_PATH || '';
  const testIpaPathV2 = process.env.TEST_IPA_PATH_2 || '';
  const testBundleId = process.env.TEST_BUNDLE_ID || '';

  before(async function () {
    // Skip tests if required environment variables are not set
    if (!testIpaPathV1 || !testBundleId) {
      log.warn(
        'Skipping AFC + Installation Proxy workflow tests: TEST_IPA_PATH and TEST_BUNDLE_ID must be set',
      );
      this.skip();
      return;
    }

    if (!udid) {
      log.warn('Skipping tests: UDID environment variable not set');
      this.skip();
      return;
    }

    try {
      log.info('Initializing AFC and Installation Proxy services...');

      // Create ONE RemoteXPC connection to be shared by both services
      const { remoteXPC: rxpc, tunnelConnection } =
        await Services.createRemoteXPCConnection(udid);
      remoteXPC = rxpc;

      // Manually create AFC service from the shared connection
      const afcDescriptor = remoteXPC.findService(AfcService.RSD_SERVICE_NAME);
      afcService = new AfcService([
        tunnelConnection.host,
        parseInt(afcDescriptor.port, 10),
      ]);
      log.info('AFC service initialized');

      // Manually create Installation Proxy service from the SAME connection
      const installationProxyDescriptor = remoteXPC.findService(
        InstallationProxyService.RSD_SERVICE_NAME,
      );
      installationProxyService = new InstallationProxyService([
        tunnelConnection.host,
        parseInt(installationProxyDescriptor.port, 10),
      ]);
      log.info('Installation Proxy service initialized');
    } catch (error) {
      log.error('Failed to initialize services:', error);
      throw error;
    }
  });

  after(async function () {
    // Cleanup: Close RemoteXPC connection
    // Note: Don't close individual services before closing remoteXPC
    // Closing service sockets causes iOS to reset the RemoteXPC connection
    // Just close remoteXPC and let it handle cleanup
    if (remoteXPC) {
      try {
        await remoteXPC.close();
        log.info('RemoteXPC connection closed');
      } catch (error) {
        log.warn('Error closing RemoteXPC:', error);
      }
    }
  });

  describe('Install and Uninstall Workflow', function () {
    const remoteIpaPath = `/PublicStaging/${path.basename(testIpaPathV1 || 'test-app.ipa')}`;

    after(async function () {
      // Cleanup: Remove test IPA and app if they still exist
      try {
        const exists = await afcService.exists(remoteIpaPath);
        if (exists) {
          await afcService.rm(remoteIpaPath, true);
          log.info('Cleaned up test IPA');
        }
      } catch (error) {
        log.warn('Error cleaning up IPA file:', error);
      }

      try {
        const apps = await installationProxyService.lookup([testBundleId!]);
        if (apps[testBundleId!]) {
          await installationProxyService.uninstall(testBundleId!);
          log.info('Cleaned up test app');
        }
      } catch (error) {
        log.warn('Error cleaning up test app:', error);
      }
    });

    it('should upload IPA file to device via AFC', async function () {
      log.info(`Uploading IPA from ${testIpaPathV1} to ${remoteIpaPath}`);

      // Ensure /PublicStaging directory exists
      try {
        await afcService.mkdir('/PublicStaging');
      } catch {
        // Ignore error if directory already exists
      }

      // Upload the IPA file
      await afcService.push(testIpaPathV1!, remoteIpaPath);
      log.info('IPA uploaded successfully');

      // Verify the file exists
      const exists = await afcService.exists(remoteIpaPath);
      expect(exists).to.be.true;
    });

    it('should install app via Installation Proxy', async function () {
      log.info(`Installing app from ${remoteIpaPath}`);

      const progressUpdates: Array<{ percent: number; status: string }> = [];

      // Install the app with progress callback
      await installationProxyService.install(
        remoteIpaPath,
        {},
        (percent, status) => {
          log.info(`Installation progress: ${percent}% - ${status}`);
          progressUpdates.push({ percent, status });
        },
      );

      log.info('Installation completed');
      log.info(`Received ${progressUpdates.length} progress updates`);

      // Verify we received progress updates
      expect(progressUpdates.length).to.be.greaterThan(0);

      // Wait 5 seconds for the device to finalize installation
      log.info('Waiting 5 seconds for device to finalize installation...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      log.info('Installation finalized on device');
    });

    it('should uninstall app via Installation Proxy', async function () {
      log.info(`Uninstalling app: ${testBundleId}`);

      const progressUpdates: Array<{ percent: number; status: string }> = [];

      // Uninstall the app with progress callback
      await installationProxyService.uninstall(
        testBundleId!,
        {},
        (percent, status) => {
          log.info(`Uninstallation progress: ${percent}% - ${status}`);
          progressUpdates.push({ percent, status });
        },
      );

      log.info('Uninstallation completed');
      log.info(`Received ${progressUpdates.length} progress updates`);
    });

    it('should cleanup IPA file from device', async function () {
      log.info(`Removing IPA file: ${remoteIpaPath}`);

      // Remove the uploaded IPA
      await afcService.rm(remoteIpaPath, true);

      // Verify it's been removed
      const exists = await afcService.exists(remoteIpaPath);
      expect(exists).to.be.false;

      log.info('IPA file cleaned up successfully');
    });
  });

  describe('Smart Install/Upgrade with version checking', function () {
    const remoteIpaPathV1 = `/PublicStaging/${path.basename(testIpaPathV1)}`;
    const remoteIpaPathV2 = `/PublicStaging/${path.basename(testIpaPathV2)}`;

    before(async function () {
      // Upload both IPA versions for tests
      log.info('Preparing IPAs');

      try {
        await afcService.mkdir('/PublicStaging');
      } catch {
        // Directory already exists
      }

      // Upload first IPA
      const existsV1 = await afcService.exists(remoteIpaPathV1);
      if (!existsV1) {
        await afcService.push(testIpaPathV1, remoteIpaPathV1);
        log.info('First IPA uploaded');
      }

      // Upload second IPA
      const existsV2 = await afcService.exists(remoteIpaPathV2);
      if (!existsV2) {
        await afcService.push(testIpaPathV2, remoteIpaPathV2);
        log.info('Second IPA uploaded');
      }
    });

    after(async function () {
      // Cleanup both IPAs
      try {
        const existsV1 = await afcService.exists(remoteIpaPathV1);
        if (existsV1) {
          await afcService.rm(remoteIpaPathV1, true);
        }
        const existsV2 = await afcService.exists(remoteIpaPathV2);
        if (existsV2) {
          await afcService.rm(remoteIpaPathV2, true);
        }
      } catch (error) {
        log.warn('Error cleaning up IPAs:', error);
      }

      try {
        const apps = await installationProxyService.lookup([testBundleId!]);
        if (apps[testBundleId!]) {
          await installationProxyService.uninstall(testBundleId!);
        }
      } catch (error) {
        log.warn('Error cleaning up app:', error);
      }
    });

    it('Scenario 1: should install fresh app (not installed)', async function () {
      log.info('Testing Scenario 1: Fresh installation');

      // Ensure app is not installed
      const apps = await installationProxyService.lookup([testBundleId!]);
      if (apps[testBundleId!]) {
        await installationProxyService.uninstall(testBundleId!);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Install first version
      await installationProxyService.install(
        remoteIpaPathV1,
        {},
        (percent, status) => {
          log.info(`Installation progress: ${percent}% - ${status}`);
        },
      );

      // Verify app is actually installed and get version
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const verifyApps = await installationProxyService.lookup([testBundleId!]);
      expect(verifyApps[testBundleId!]).to.exist;

      const installedVersion =
        verifyApps[testBundleId!].CFBundleShortVersionString ||
        verifyApps[testBundleId!].CFBundleVersion;

      log.info(`Installed version: ${installedVersion}`);
    });

    it('Scenario 2: should verify app is installed with correct version', async function () {
      log.info('Testing Scenario 2: Verify installed app');

      // Get current installed version
      const apps = await installationProxyService.lookup([testBundleId!]);
      expect(apps[testBundleId!]).to.exist;

      const installedVersion =
        apps[testBundleId!].CFBundleShortVersionString ||
        apps[testBundleId!].CFBundleVersion;

      log.info(`Current installed version: ${installedVersion}`);
      expect(installedVersion).to.exist;

      // Use isAppInstalled helper
      const installStatus = await installationProxyService.isAppInstalled(
        testBundleId!,
      );
      expect(installStatus.isInstalled).to.be.true;
      expect(installStatus.version).to.equal(installedVersion);
    });

    it('Scenario 3: should upgrade to newer version', async function () {
      log.info('Testing Scenario 3: Upgrade to newer version');

      // Get current version before upgrade
      const appsBeforeUpgrade = await installationProxyService.lookup([
        testBundleId!,
      ]);
      const versionBefore =
        appsBeforeUpgrade[testBundleId!].CFBundleShortVersionString ||
        appsBeforeUpgrade[testBundleId!].CFBundleVersion;

      log.info(`Current version: ${versionBefore}`);

      // Perform upgrade with second IPA
      await installationProxyService.upgrade(
        remoteIpaPathV2,
        {},
        (percent, status) => {
          log.info(`Upgrade progress: ${percent}% - ${status}`);
        },
      );

      // Verify version changed
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const appsAfterUpgrade = await installationProxyService.lookup([
        testBundleId!,
      ]);
      const versionAfter =
        appsAfterUpgrade[testBundleId!].CFBundleShortVersionString ||
        appsAfterUpgrade[testBundleId!].CFBundleVersion;

      log.info(`Upgraded from ${versionBefore} to ${versionAfter}`);
      expect(versionAfter).to.not.equal(versionBefore);
    });

    it('Scenario 4: should verify final installed version', async function () {
      log.info('Testing Scenario 4: Verify final version');

      // Get final version after all upgrades
      const apps = await installationProxyService.lookup([testBundleId!]);
      const finalVersion =
        apps[testBundleId!].CFBundleShortVersionString ||
        apps[testBundleId!].CFBundleVersion;

      log.info(`Final installed version: ${finalVersion}`);
      expect(finalVersion).to.exist;

      // Verify with isAppInstalled helper
      const installStatus = await installationProxyService.isAppInstalled(
        testBundleId!,
      );
      expect(installStatus.isInstalled).to.be.true;
      expect(installStatus.version).to.equal(finalVersion);
      expect(installStatus.appInfo).to.exist;
    });

    it('should use isAppInstalled helper correctly', async function () {
      log.info('Testing isAppInstalled helper');

      // Test with installed app
      const installedResult = await installationProxyService.isAppInstalled(
        testBundleId!,
      );

      expect(installedResult.isInstalled).to.be.true;
      expect(installedResult.version).to.exist;
      expect(installedResult.appInfo).to.exist;
      expect(installedResult.appInfo?.CFBundleIdentifier).to.equal(
        testBundleId,
      );

      log.info(`Installed app version: ${installedResult.version}`);

      // Test with non-existent app
      const notInstalledResult = await installationProxyService.isAppInstalled(
        'com.nonexistent.app',
      );

      expect(notInstalledResult.isInstalled).to.be.false;
      expect(notInstalledResult.version).to.be.undefined;
      expect(notInstalledResult.appInfo).to.be.undefined;
    });
  });
});
