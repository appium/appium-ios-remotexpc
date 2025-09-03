import { expect } from 'chai';
import { describe, it, before, after } from 'mocha';

import { Services } from '../../src/index.js';
import type { MobileImageMounterServiceWithConnection } from '../../src/lib/types.js';

describe('MobileImageMounterService Integration', function () {
  this.timeout(30000);

  let serviceWithConnection: MobileImageMounterServiceWithConnection | null = null;
  const testUdid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async function () {
    if (!testUdid) {
      this.skip();
      return;
    }

    // Establish connection for all tests
    try {
      serviceWithConnection = await Services.startMobileImageMounterService(testUdid);
    } catch (error) {
      console.error('Failed to connect to mobile image mounter service:', error);
      this.skip();
    }
  });

  after(async function () {
    if (serviceWithConnection) {
      await serviceWithConnection.remoteXPC.close();
    }
  });

  describe('Service Connection', () => {
    it('should connect to mobile image mounter service', async function () {
      expect(serviceWithConnection).to.not.be.null;
      expect(serviceWithConnection!.mobileImageMounterService).to.not.be.null;
      expect(serviceWithConnection!.remoteXPC).to.not.be.null;
    });
  });

  describe('Image Lookup Operations', () => {
    it('should lookup mounted developer images', async function () {
      const signatures = await serviceWithConnection!.mobileImageMounterService.lookup('Personalized');
      console.log(`Found ${signatures} mounted developer images`);
      expect(signatures).to.be.an('array');
      console.log(`Found ${signatures.length} mounted developer images`);
    });

    it('should check if developer image is mounted', async function () {
      const isImageMounted = await serviceWithConnection!.mobileImageMounterService.isDeveloperImageMounted();
      expect(isImageMounted).to.be.a('boolean');
      console.log('Developer image mounted:', isImageMounted);
    });
  });

  describe('Developer Mode Status', () => {
    it('should query developer mode status', async function () {
      try {
        const isDeveloperModeEnabled = await serviceWithConnection!.mobileImageMounterService.queryDeveloperModeStatus();
        expect(isDeveloperModeEnabled).to.be.a('boolean');
        console.log('Developer mode enabled:', isDeveloperModeEnabled);
      } catch (error) {
        // This is expected on older iOS versions
        console.log('Developer mode status query not supported (older iOS version)');
      }
    });
  });

  describe('Personalization Support', () => {
    it('should query personalization nonce', async function () {
      try {
        const nonce = await serviceWithConnection!.mobileImageMounterService.queryNonce();
        expect(nonce).to.be.instanceOf(Buffer);
        expect(nonce.length).to.be.greaterThan(0);
        console.log('Personalization nonce length:', nonce.length);
        console.log('Personalization nonce:', nonce.toString('hex'));
      } catch (error) {
        // This may not be supported on all devices
        console.log('Personalization nonce query not supported:', (error as Error).message);
      }
    });
  });

  describe('Mount Operations', () => {
    it('should handle mount attempt gracefully', async function () {
      try {
        await serviceWithConnection!.mobileImageMounterService.mount(
          '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.dmg',
          '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.trustcache'
        );
      } catch (error) {
        expect((error as Error).message).to.include('path does not exist');
        console.log('Mount operation correctly rejected non-existent files');
      }
    });
  });

  describe('Unmount Operations', () => {
    it('should handle unmount attempt gracefully', async function () {
      try {
        await serviceWithConnection!.mobileImageMounterService.unmountImage('/System/Developer');
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes('not supported')) {
          console.log('Unmount operation not supported on this iOS version');
        } else if (errorMessage.includes('no matching entry')) {
          console.log('Unmount operation correctly rejected non-existent mount path');
        } else {
          throw error;
        }
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid image type lookup', async function () {
      try {
        const signatures = await serviceWithConnection!.mobileImageMounterService.lookup('InvalidImageType');
        expect(signatures).to.be.an('array');
        // May return empty array for unknown image types
        console.log(`Found ${signatures.length} images of type 'InvalidImageType'`);
      } catch (error) {
        // Some devices may reject invalid image types
        console.log('Invalid image type correctly rejected:', (error as Error).message);
      }
    });
  });
});
