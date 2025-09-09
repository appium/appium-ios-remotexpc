import { expect } from 'chai';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { after, before, describe } from 'mocha';

import { Services } from '../../src/index.js';
import type { MobileImageMounterServiceWithConnection } from '../../src/index.js';

describe('MobileImageMounterService Integration', function () {
  this.timeout(40000);

  let serviceWithConnection: MobileImageMounterServiceWithConnection | null =
    null;
  const testUdid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async function () {
    if (!testUdid) {
      this.skip();
      return;
    }

    // Establish connection for all tests
    try {
      serviceWithConnection =
        await Services.startMobileImageMounterService(testUdid);
    } catch (error) {
      console.error(
        'Failed to connect to mobile image mounter service:',
        error,
      );
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

  describe('Mount Operations', () => {
    it('should handle personalized mount attempt gracefully', async function () {
      const imagePath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.dmg';
      const buildManifestPath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/BuildManifest.plist';
      const trustCachePath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.trustcache';

      try {
        await serviceWithConnection!.mobileImageMounterService.mount(
          imagePath,
          buildManifestPath,
          trustCachePath,
        );
        console.log('Mount operation succeeded');
      } catch (error) {
        const errorMessage = (error as Error).message;
        console.log('Mount operation failed with error:', errorMessage);
        if (errorMessage.includes('path does not exist')) {
          console.log('Mount operation correctly rejected non-existent files');
        } else if (errorMessage.includes('already mounted')) {
          console.log('Image already mounted');
        } else if (errorMessage.includes('manifest not found')) {
          console.log('Personalization manifest not found (expected)');
        } else {
          console.log('Mount failed with error:', errorMessage);
        }
      }
    });
  });

  describe('Image Lookup Operations', () => {
    it('should lookup mounted personalized images', async function () {
      const signatures =
        await serviceWithConnection!.mobileImageMounterService.lookup(
          'Personalized',
        );
      expect(signatures).to.be.an('array');
      console.log(`Found ${signatures.length} mounted personalized images`);
      console.log(
        'Mounted personalized images:',
        signatures.map((sig) => sig.toString('hex')),
      );
    });

    it('should check if developer image is mounted', async function () {
      const isImageMounted =
        await serviceWithConnection!.mobileImageMounterService.isDeveloperImageMounted();
      expect(isImageMounted).to.be.a('boolean');
      console.log('Developer image mounted:', isImageMounted);
    });

    it('should copy devices list (test CopyDevices command)', async function () {
      try {
        const devices =
          await serviceWithConnection!.mobileImageMounterService.copyDevices();
        expect(devices).to.be.an('array');
        console.log('CopyDevices response:', JSON.stringify(devices, null, 2));
      } catch (error) {
        console.error('CopyDevices failed:', (error as Error).message);
      }
    });
  });

  describe('Developer Mode Status', () => {
    it('should query developer mode status', async function () {
      try {
        const isDeveloperModeEnabled =
          await serviceWithConnection!.mobileImageMounterService.queryDeveloperModeStatus();
        expect(isDeveloperModeEnabled).to.be.a('boolean');
        console.log('Developer mode enabled:', isDeveloperModeEnabled);
      } catch (error) {
        // This is expected on older iOS versions
        console.log(
          'Developer mode status query not supported (older iOS version)',
        );
      }
    });
  });

  describe('Personalization Support', () => {
    it('should query personalization identifiers only', async function () {
      try {
        const identifiers =
          await serviceWithConnection!.mobileImageMounterService.queryPersonalizationIdentifiers();
        expect(identifiers).to.be.an('object');

        console.log(JSON.stringify(identifiers, null, 2));
      } catch (error) {
        console.log(
          'Personalization identifiers query failed:',
          (error as Error).message,
        );
        throw error;
      }
    });

    it('should test queryPersonalizationManifest behavior', async function () {
      // First, let's check what signatures are currently mounted
      try {
        console.log('=== CHECKING CURRENTLY MOUNTED SIGNATURES ===');
        const mountedSignatures =
          await serviceWithConnection!.mobileImageMounterService.lookup();
        console.log('Number of mounted signatures:', mountedSignatures.length);

        if (mountedSignatures.length > 0) {
          for (let i = 0; i < mountedSignatures.length; i++) {
            const sig = mountedSignatures[i];
            console.log(`Mounted signature ${i + 1}:`, sig.toString('hex'));
            console.log(`Mounted signature ${i + 1} length:`, sig.length);

            // Try to query with this mounted signature
            try {
              console.log(`=== TESTING WITH MOUNTED SIGNATURE ${i + 1} ===`);
              const manifest =
                await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
                  'DeveloperDiskImage',
                  sig,
                );

              console.log('SUCCESS: Manifest received with mounted signature!');
              console.log('Manifest length:', manifest.length);
              console.log('Full Manifest: ', manifest.toString('hex'));
              return; // Found working signature, exit test successfully
            } catch (error) {
              const errorMessage = (error as Error).message;
              console.log(
                `Query with mounted signature ${i + 1} failed:`,
                errorMessage,
              );
            }
          }
        }

        // If no mounted signatures or none worked, try with image hash
        console.log('=== TESTING WITH IMAGE HASH ===');
        const imageFilePath =
          '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.dmg';
        const image = await fs.readFile(imageFilePath);
        const imageHash = createHash('sha384').update(image).digest();

        console.log('Using image hash:', imageHash.toString('hex'));
        console.log('Image hash length:', imageHash.length);

        const manifest =
          await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
            'DeveloperDiskImage',
            imageHash,
          );

        console.log('SUCCESS: Manifest received with image hash!');
        console.log('Manifest length:', manifest.length);
        console.log('Full manifest:', manifest.toString('hex'));

        expect(manifest).to.be.instanceOf(Buffer);
        expect(manifest.length).to.be.greaterThan(0);
      } catch (error) {
        const errorMessage = (error as Error).message;
        console.log(
          'QueryPersonalizationManifest failed with error:',
          errorMessage,
        );

        if (errorMessage.includes('MissingManifestError')) {
          console.log(
            '✓ Got expected MissingManifestError - manifest not found on device',
          );
        } else if (errorMessage.includes('Timed out')) {
          console.log(
            '✓ Got timeout error - this means device closed connection',
          );
        } else {
          console.log('⚠️  Got unexpected error:', errorMessage);
        }

        // Don't throw the error - we expect this to fail
        expect(errorMessage).to.satisfy(
          (msg: string) =>
            msg.includes('MissingManifestError') ||
            msg.includes('Timed out') ||
            msg.includes('timeout') ||
            msg.includes('InternalError'),
        );
      }
    });

    it('should query personalization nonce', async function () {
      try {
        const nonce =
          await serviceWithConnection!.mobileImageMounterService.queryNonce();
        expect(nonce).to.be.instanceOf(Buffer);
        expect(nonce.length).to.be.greaterThan(0);
        console.log('Personalization nonce length:', nonce.length);
        console.log('Personalization nonce:', nonce.toString('hex'));
      } catch (error) {
        // This may not be supported on all devices
        console.log(
          'Personalization nonce query not supported:',
          (error as Error).message,
        );
      }
    });
  });

  describe('Unmount Operations', () => {
    it('should handle unmount attempt gracefully', async function () {
      try {
        await serviceWithConnection!.mobileImageMounterService.unmountImage(
          '/System/Developer',
        );
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes('not supported')) {
          console.log('Unmount operation not supported on this iOS version');
        } else if (errorMessage.includes('no matching entry')) {
          console.log(
            'Unmount operation correctly rejected non-existent mount path',
          );
        } else {
          throw error;
        }
      }
    });
  });
});
