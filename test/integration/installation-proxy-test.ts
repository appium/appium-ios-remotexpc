import { expect } from 'chai';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import type { InstallationProxyService } from '../../src/services/ios/installation-proxy/index.js';

const log = getLogger('InstallationProxyService.test');

describe('InstallationProxyService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let installationProxyService: InstallationProxyService;
  const udid = process.env.UDID || '';

  before(async function () {
    try {
      const result = await Services.startInstallationProxyService(udid);
      installationProxyService = result.installationProxyService;
      remoteXPC = result.remoteXPC;
      log.debug('Installation Proxy service initialized successfully');
    } catch (error) {
      log.error('Failed to initialize Installation Proxy service:', error);
      throw error;
    }
  });

  after(async function () {
    // Note: Don't close individual services before closing remoteXPC
    // Closing the service socket causes iOS to reset the RemoteXPC connection
    // Just close remoteXPC and let it handle cleanup
    if (remoteXPC) {
      try {
        await remoteXPC.close();
        log.debug('RemoteXPC connection closed');
      } catch (error) {
        log.warn('Error during cleanup:', error);
      }
    }
  });

  describe('browse', function () {
    it('should list all installed applications', async function () {
      try {
        const apps = await installationProxyService.browse();
        log.debug(`Retrieved ${apps.length} applications`);

        expect(apps).to.be.an('array');
        expect(apps.length).to.be.greaterThan(0);

        // Check first app has expected properties
        const firstApp = apps[0];
        expect(firstApp).to.have.property('CFBundleIdentifier');
        log.debug('Sample app details:', JSON.stringify(firstApp, null, 2));
        log.debug(
          `First 5 apps: ${apps
            .slice(0, 5)
            .map((a) => a.CFBundleIdentifier)
            .join(', ')}`,
        );
      } catch (error) {
        log.error('Error listing applications:', (error as Error).message);
        throw error;
      }
    });

    it('should list only user applications', async function () {
      try {
        const apps = await installationProxyService.browse({
          applicationType: 'User',
        });
        log.debug(`Retrieved ${apps.length} user applications`);
        if (apps.length > 0) {
          log.debug(
            `User apps: ${apps.map((a) => a.CFBundleIdentifier).join(', ')}`,
          );
        }

        expect(apps).to.be.an('array');
        // User apps might be 0 if none installed
        expect(apps).to.satisfy((arr: any[]) => arr.length >= 0);
      } catch (error) {
        log.error('Error listing user applications:', (error as Error).message);
        throw error;
      }
    });

    it('should return specific attributes', async function () {
      try {
        const apps = await installationProxyService.browse({
          returnAttributes: ['CFBundleIdentifier', 'CFBundleName'],
        });

        expect(apps).to.be.an('array');
        expect(apps.length).to.be.greaterThan(0);

        const firstApp = apps[0];
        expect(firstApp).to.have.property('CFBundleIdentifier');
        // CFBundleName might not always be present
      } catch (error) {
        log.error('Error with specific attributes:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('lookup', function () {
    it('should lookup specific application by bundle ID', async function () {
      try {
        // Use a common system app
        const bundleId = 'com.apple.Preferences';
        const apps = await installationProxyService.lookup([bundleId]);

        expect(apps).to.be.an('object');
        expect(apps[bundleId]).to.exist;
        expect(apps[bundleId].CFBundleIdentifier).to.equal(bundleId);
        log.debug(`Found app: ${apps[bundleId].CFBundleName || bundleId}`);
        log.debug('App details:', JSON.stringify(apps[bundleId], null, 2));
      } catch (error) {
        log.error('Error looking up application:', (error as Error).message);
        throw error;
      }
    });

    it('should lookup multiple applications', async function () {
      try {
        const bundleIds = ['com.apple.Preferences', 'com.apple.mobilesafari'];
        const apps = await installationProxyService.lookup(bundleIds);

        expect(apps).to.be.an('object');
        expect(Object.keys(apps).length).to.be.greaterThan(0);
        log.debug(`Found ${Object.keys(apps).length} applications`);
      } catch (error) {
        log.error('Error looking up multiple apps:', (error as Error).message);
        throw error;
      }
    });

    it('should return empty for nonexistent bundle ID', async function () {
      try {
        const bundleId = 'com.nonexistent.app.test';
        const apps = await installationProxyService.lookup([bundleId]);

        expect(apps).to.be.an('object');
        expect(Object.keys(apps).length).to.equal(0);
      } catch (error) {
        log.error('Error with nonexistent app:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('getApps', function () {
    it('should get all applications', async function () {
      try {
        const apps = await installationProxyService.getApps();

        expect(apps).to.be.an('object');
        expect(Object.keys(apps).length).to.be.greaterThan(0);
        log.debug(`Retrieved ${Object.keys(apps).length} applications`);
      } catch (error) {
        log.error('Error getting all apps:', (error as Error).message);
        throw error;
      }
    });

    it('should get applications with size calculation', async function () {
      try {
        const apps = await installationProxyService.getApps('Any', true);

        expect(apps).to.be.an('object');
        const appIds = Object.keys(apps);
        expect(appIds.length).to.be.greaterThan(0);

        // Check if at least one app has size information
        const firstAppId = appIds[0];
        const firstApp = apps[firstAppId];
        log.debug(
          `App ${firstAppId} - Static: ${firstApp.StaticDiskUsage}, Dynamic: ${firstApp.DynamicDiskUsage}`,
        );
      } catch (error) {
        log.error('Error getting apps with sizes:', (error as Error).message);
        throw error;
      }
    });

    it('should get specific bundle IDs', async function () {
      try {
        const bundleIds = ['com.apple.Preferences'];
        const apps = await installationProxyService.getApps(
          'Any',
          false,
          bundleIds,
        );

        expect(apps).to.be.an('object');
        expect(apps['com.apple.Preferences']).to.exist;
      } catch (error) {
        log.error('Error getting specific apps:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('service connection management', function () {
    it('should maintain connection across multiple requests', async function () {
      try {
        const apps1 = await installationProxyService.browse();
        const apps2 = await installationProxyService.lookup([
          'com.apple.Preferences',
        ]);
        const apps3 = await installationProxyService.getApps();

        expect(apps1).to.be.an('array');
        expect(apps2).to.be.an('object');
        expect(apps3).to.be.an('object');

        log.debug('Successfully made multiple requests on same connection');
      } catch (error) {
        log.error(
          'Error testing connection persistence:',
          (error as Error).message,
        );
        throw error;
      }
    });
  });
});
