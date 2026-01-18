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
 * - TEST_IPA_PATH: Path to test IPA file (e.g., /path/to/TestApp.ipa)
 * - TEST_BUNDLE_ID: Bundle ID of the test app (e.g., com.example.testapp)
 *
 * Example:
 * UDID=00008030-... TEST_IPA_PATH=./test.ipa TEST_BUNDLE_ID=com.test.app npm run test:installation-workflow
 */
describe('AFC + Installation Proxy Workflow', function () {
  // Installation can take several minutes depending on app size
  this.timeout(300000); // 5 minutes

  let remoteXPC: any;
  let afcService: AfcService;
  let installationProxyService: InstallationProxyService;

  const udid = process.env.UDID || '';
  const testIpaPath = process.env.TEST_IPA_PATH || '';
  const testBundleId = process.env.TEST_BUNDLE_ID || '';

  before(async function () {
    // Skip tests if required environment variables are not set
    if (!testIpaPath || !testBundleId) {
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
    const remoteIpaPath = `/PublicStaging/${path.basename(testIpaPath || 'test-app.ipa')}`;

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
      log.info(`Uploading IPA from ${testIpaPath} to ${remoteIpaPath}`);

      // Ensure /PublicStaging directory exists
      try {
        await afcService.mkdir('/PublicStaging');
      } catch {
        // Ignore error if directory already exists
      }

      // Upload the IPA file
      await afcService.push(testIpaPath!, remoteIpaPath);
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
});
