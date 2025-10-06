import { logger } from '@appium/support';
import { expect } from 'chai';

import type { SpringboardService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('SpringBoardService.test');
// Set SpringBoardService logger to info level
log.level = 'info';

describe('SpringBoardService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let springboardService: SpringboardService;
  const udid = process.env.UDID || '00008030-000318693E32402E';

  before(async function () {
    try {
      const result = await Services.startSpringboardService(udid);
      springboardService = result.springboardService;
      remoteXPC = result.remoteXPC;
      log.info('SpringBoard service initialized successfully');
    } catch (error) {
      log.error('Failed to initialize SpringBoard service:', error);
      throw error;
    }
  });

  after(async function () {
    if (remoteXPC) {
      try {
        await remoteXPC.close();
        log.info('SpringBoard service connection closed');
      } catch (error) {
        log.warn('Error during cleanup:', error);
        // Ignore cleanup errors in tests
      }
    }
  });

  describe('getIconState', function () {
    it('should retrieve the current icon state', async function () {
      try {
        const iconState = await springboardService.getIconState();
        log.debug('Retrieved icon state:', JSON.stringify(iconState, null, 2));

        expect(iconState).to.be.an('object');
        expect(iconState).to.not.be.empty;

        console.log(iconState);

        // Icon state typically contains iconLists array
        if (iconState.iconLists) {
          expect(iconState.iconLists).to.be.an('array');
        }
      } catch (error) {
        log.error('Error getting icon state:', (error as Error).message);
        throw error;
      }
    });

    // it('should handle errors gracefully when service is unavailable', async function () {
    //   // This test simulates error handling - we expect the method to throw with a descriptive error
    //   try {
    //     // Force an error by creating a service with invalid address
    //     const invalidService = new (await import('../../src/services/ios/springboard-service/index.js')).SpringBoardService(['invalid', 0]);
    //     await invalidService.getIconState();
    //
    //     // If we reach here, the test should fail
    //     expect.fail('Expected method to throw an error');
    //   } catch (error) {
    //     expect(error).to.be.an('error');
    //     expect((error as Error).message).to.include('Failed to get Icon state');
    //   }
    // });
  });

  describe('getIconPNGData', function () {
    it('should retrieve PNG data for a valid bundle ID', async function () {
      // Use a common system app bundle ID that should exist on most devices
      const bundleId = 'com.apple.weather'; // Messages app

      try {
        const pngData = await springboardService.getIconPNGData(bundleId);
        log.debug(`Retrieved PNG data for ${bundleId}, size: ${pngData.length} bytes`);

        expect(pngData).to.be.instanceOf(Buffer);
        expect(pngData.length).to.be.greaterThan(0);

        // Verify it's actually PNG data by checking the PNG signature
        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        expect(pngData.subarray(0, 8)).to.deep.equal(pngSignature);
      } catch (error) {
        log.error(`Error getting PNG data for ${bundleId}:`, (error as Error).message);
        throw error;
      }
    });

    // it('should handle invalid bundle ID gracefully', async function () {
    //   const invalidBundleId = 'com.invalid.nonexistent.app';
    //
    //   try {
    //     await springboardService.getIconPNGData(invalidBundleId);
    //     // If we reach here without error, that's also acceptable - some implementations might return empty data
    //   } catch (error) {
    //     expect(error).to.be.an('error');
    //     expect((error as Error).message).to.include('Failed to get Icon PNG data');
    //   }
    // });
    //
    // it('should handle empty bundle ID', async function () {
    //   try {
    //     await springboardService.getIconPNGData('');
    //   } catch (error) {
    //     expect(error).to.be.an('error');
    //     expect((error as Error).message).to.include('Failed to get Icon PNG data');
    //   }
    // });
  });

  describe('getWallpaperInfo', function () {
    it('should retrieve wallpaper info for lock screen', async function () {
      const wallpaperName = 'LockBackground';

      try {
        const wallpaperInfo = await springboardService.getWallpaperInfo(wallpaperName);
        log.debug(`Retrieved wallpaper info for ${wallpaperName}:`, JSON.stringify(wallpaperInfo, null, 2));

        expect(wallpaperInfo).to.be.an('object');
        // Wallpaper info might contain properties like imageData, cropRect, etc.
      } catch (error) {
        log.error(`Error getting wallpaper info for ${wallpaperName}:`, (error as Error).message);
        throw error;
      }
    });

    it('should retrieve wallpaper info for home screen', async function () {
      const wallpaperName = 'HomeBackground';

      try {
        const wallpaperInfo = await springboardService.getWallpaperInfo(wallpaperName);
        log.debug(`Retrieved wallpaper info for ${wallpaperName}:`, JSON.stringify(wallpaperInfo, null, 2));

        expect(wallpaperInfo).to.be.an('object');
      } catch (error) {
        log.error(`Error getting wallpaper info for ${wallpaperName}:`, (error as Error).message);
        throw error;
      }
    });

    it('should handle invalid wallpaper name', async function () {
      const invalidWallpaperName = 'InvalidWallpaper';

      try {
        const result = await springboardService.getWallpaperInfo(invalidWallpaperName);
        // Some implementations might return empty object for invalid names
        expect(result).to.be.an('object');
      } catch (error) {
        expect(error).to.be.an('error');
        expect((error as Error).message).to.include('Failed to get wallpaper info');
      }
    });
  });

  describe('getHomescreenIconMetrics', function () {
    it('should retrieve homescreen icon metrics', async function () {
      try {
        const metrics = await springboardService.getHomescreenIconMetrics();
        log.debug('Retrieved homescreen icon metrics:', JSON.stringify(metrics, null, 2));

        expect(metrics).to.be.an('object');
        expect(metrics).to.not.be.empty;

        // Icon metrics typically contain information about icon layout, sizes, etc.
        // Common properties might include iconImageSize, iconSpacing, etc.
      } catch (error) {
        log.error('Error getting homescreen icon metrics:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('service connection management', function () {
    it('should maintain connection across multiple requests', async function () {
      try {
        // Make multiple requests to ensure connection is maintained
        const iconState1 = await springboardService.getIconState();
        const metrics = await springboardService.getHomescreenIconMetrics();
        const iconState2 = await springboardService.getIconState();

        expect(iconState1).to.be.an('object');
        expect(metrics).to.be.an('object');
        expect(iconState2).to.be.an('object');

        // Verify that we get consistent results
        expect(iconState1).to.deep.equal(iconState2);
      } catch (error) {
        log.error('Error testing connection persistence:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('error handling', function () {
    it('should provide meaningful error messages', async function () {
      try {
        // Test with a service that has invalid configuration
        const invalidService = new (await import('../../src/services/ios/springboard-service/index.js')).SpringBoardService(['127.0.0.1', 99999]);
        await invalidService.getIconState();

        expect.fail('Expected method to throw an error');
      } catch (error) {
        expect(error).to.be.an('error');
        const errorMessage = (error as Error).message;
        expect(errorMessage).to.be.a('string');
        expect(errorMessage.length).to.be.greaterThan(0);
        expect(errorMessage).to.include('Failed to get Icon state');
      }
    });
  });
});
