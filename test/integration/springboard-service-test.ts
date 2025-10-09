import { logger } from '@appium/support';
import { expect } from 'chai';

import type { SpringboardService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import { InterfaceOrientation } from '../../src/services/ios/springboard-service/index.js';

const log = logger.getLogger('SpringBoardService.test');
// Set SpringBoardService logger to info level
log.level = 'info';

describe('SpringBoardService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let springboardService: SpringboardService;
  const udid = process.env.UDID || '';

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

        expect(iconState).not.be.empty;
      } catch (error) {
        log.error('Error getting icon state:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('setIconState', function () {
    // Skip test as it is not working due to a bug in Apple protocol
    it.skip('should set the icon state without errors', async function () {
      try {
        const iconState = await springboardService.getIconState();
        // Check if iconState is not null and has at least one element
        if (iconState && Array.isArray(iconState) && iconState.length > 0) {
          // Reverse the first page of icons
          const firstPage = iconState[1];
          if (Array.isArray(firstPage)) {
            iconState[1] = firstPage.reverse();
          }

          // Set the modified icon state
          await springboardService.setIconState(iconState);

          // Verify the change was applied
          const newIconState = await springboardService.getIconState();
          expect(newIconState).to.deep.equal(iconState);
        }
      } catch (error) {
        log.error('Error setting icon state:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('getIconPNGData', function () {
    it('should retrieve PNG data for a valid bundle ID', async function () {
      // Use a common system app bundle ID that should exist on most devices
      const bundleId = 'com.apple.weather'; // Messages app

      try {
        const pngData = await springboardService.getIconPNGData(bundleId);
        log.debug(
          `Retrieved PNG data for ${bundleId}, size: ${pngData.length} bytes`,
        );

        expect(pngData).to.be.instanceOf(Buffer);
        expect(pngData.length).to.be.greaterThan(0);

        // Verify it's actually PNG data by checking the PNG signature
        const pngSignature = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(pngData.subarray(0, 8)).to.deep.equal(pngSignature);

        expect(pngData.length).to.be.greaterThan(10000); // Typical icon size
      } catch (error) {
        log.error(
          `Error getting PNG data for ${bundleId}:`,
          (error as Error).message,
        );
        throw error;
      }
    });

    it('check invalid bundle ID', async function () {
      const invalidBundleId = 'com.invalid.nonexistent.app';

      try {
        const invalid =
          await springboardService.getIconPNGData(invalidBundleId);

        // Invalid bundle IDs will return some default icon data
        // also have length between 7000 and 10000 bytes
        expect(invalid.length).to.be.greaterThan(7000);
        expect(invalid.length).to.be.lessThan(10000);

        // Verify it's actually PNG data by checking the PNG signature
        const pngSignature = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(invalid.subarray(0, 8)).to.deep.equal(pngSignature);
      } catch (error) {
        log.error(
          `Error getting PNG data for ${invalidBundleId}:`,
          (error as Error).message,
        );
        throw error;
      }
    });
  });

  describe('getHomescreenIconMetrics', function () {
    it('should retrieve homescreen icon metrics', async function () {
      try {
        const metrics = await springboardService.getHomescreenIconMetrics();
        log.debug(
          'Retrieved homescreen icon metrics:',
          JSON.stringify(metrics, null, 2),
        );

        expect(metrics).to.be.an('object');
        expect(metrics).to.not.be.empty;
        Object.keys(metrics).forEach((key) => {
          expect(key.startsWith('homeScreen')).to.be.true;
        });
      } catch (error) {
        log.error(
          'Error getting homescreen icon metrics:',
          (error as Error).message,
        );
        throw error;
      }
    });
  });

  describe('getInterfaceOrientation', function () {
    it('should retrieve the current interface orientation', async function () {
      try {
        const orientation = await springboardService.getInterfaceOrientation();
        log.debug('Retrieved interface orientation:', orientation);
        expect(orientation).to.be.oneOf(Object.values(InterfaceOrientation));
      } catch (error) {
        log.error(
          'Error getting interface orientation:',
          (error as Error).message,
        );
        throw error;
      }
    });
  });

  describe('getWallpaperPreviewImage', function () {
    it('get homescreen wallpaper preview image', async function () {
      try {
        const wallpaperName = 'homescreen';
        const pngData =
          await springboardService.getWallpaperPreviewImage(wallpaperName);
        log.debug(
          `Retrieved wallpaper preview image for ${wallpaperName}, size: ${pngData.length} bytes`,
        );

        expect(pngData.length).to.be.greaterThan(0);
        expect(pngData).to.be.instanceOf(Buffer);

        // Verify it's actually PNG data by checking the PNG signature
        const pngSignature = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(pngData.subarray(0, 8)).to.deep.equal(pngSignature);
      } catch (error) {
        log.error(
          'Error getting wallpaper preview image:',
          (error as Error).message,
        );
        throw error;
      }
    });

    it('get lockscreen wallpaper preview image', async function () {
      try {
        const wallpaperName = 'lockscreen';
        const pngData =
          await springboardService.getWallpaperPreviewImage(wallpaperName);
        log.debug(
          `Retrieved wallpaper preview image for ${wallpaperName}, size: ${pngData.length} bytes`,
        );

        expect(pngData.length).to.be.greaterThan(0);
        expect(pngData).to.be.instanceOf(Buffer);

        // Verify it's actually PNG data by checking the PNG signature
        const pngSignature = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(pngData.subarray(0, 8)).to.deep.equal(pngSignature);
      } catch (error) {
        log.error(
          'Error getting wallpaper preview image:',
          (error as Error).message,
        );
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
        log.error(
          'Error testing connection persistence:',
          (error as Error).message,
        );
        throw error;
      }
    });
  });

  describe('error handling', function () {
    it('should provide meaningful error messages', async function () {
      try {
        // Test with a service that has invalid configuration
        const invalidService = new (
          await import('../../src/services/ios/springboard-service/index.js')
        ).SpringBoardService(['127.0.0.1', 99999]);
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
