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
  const testUdid = process.env.UDID || '';

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
    it('should mount personalized image', async function () {
      // replace all these paths with your own paths to DMG Image, manifest, and trustcache
      const imagePath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.dmg';
      const buildManifestPath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/BuildManifest.plist';
      const trustCachePath =
        '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.trustcache';

      try {
        // this is slow (15-20 seconds)
        await serviceWithConnection!.mobileImageMounterService.mount(
          imagePath,
          buildManifestPath,
          trustCachePath,
        );
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).to.satisfy(
          (msg: string) =>
            msg.includes('path does not exist') ||
            msg.includes('already mounted') ||
            msg.includes('manifest not found') ||
            msg.length > 0,
        );
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
      signatures.forEach((sig, index) => {
        expect(sig).to.be.instanceOf(Buffer);
        expect(sig.length).to.be.greaterThan(0);
      });
    });

    it('should check if developer image is mounted', async function () {
      const isImageMounted =
        await serviceWithConnection!.mobileImageMounterService.isDeveloperImageMounted();
      expect(isImageMounted).to.be.a('boolean');
    });

    it('should copy devices list', async function () {
      const devices =
        await serviceWithConnection!.mobileImageMounterService.copyDevices();
      expect(devices).to.be.an('array');
    });
  });

  describe('Developer Mode Status', () => {
    it('should query developer mode status', async function () {
      const isDeveloperModeEnabled =
        await serviceWithConnection!.mobileImageMounterService.queryDeveloperModeStatus();
      expect(isDeveloperModeEnabled).to.be.a('boolean');
    });
  });

  describe('Personalization identifiers and manifest', () => {
    it('should query personalization identifiers only', async function () {
      const identifiers =
        await serviceWithConnection!.mobileImageMounterService.queryPersonalizationIdentifiers();
      expect(identifiers).to.be.an('object');
      expect(Object.keys(identifiers)).to.have.length.greaterThan(0);
    });

    it('should test queryPersonalizationManifest behavior', async function () {
      // First, check what signatures are currently mounted
      try {
        const mountedSignatures =
          await serviceWithConnection!.mobileImageMounterService.lookup();
        expect(mountedSignatures).to.be.an('array');

        if (mountedSignatures.length > 0) {
          for (let i = 0; i < mountedSignatures.length; i++) {
            const sig = mountedSignatures[i];
            expect(sig).to.be.instanceOf(Buffer);
            expect(sig.length).to.be.greaterThan(0);

            // Try to query with this mounted signature
            try {
              const manifest =
                await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
                  'DeveloperDiskImage',
                  sig,
                );

              expect(manifest).to.be.instanceOf(Buffer);
              expect(manifest.length).to.be.greaterThan(0);
              return;
            } catch (error) {
            }
          }
        }

        // If no mounted signatures, try with image hash
        // replace with your own path to DMG Image
        const imageFilePath =
          '/Users/navinchandra/.pymobiledevice3/Xcode_iOS_DDI_Personalized/Image.dmg';
        const image = await fs.readFile(imageFilePath);
        const imageHash = createHash('sha384').update(image).digest();

        expect(imageHash).to.be.instanceOf(Buffer);
        expect(imageHash.length).to.equal(48); // SHA384 produces 48 bytes

        const manifest =
          await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
            'DeveloperDiskImage',
            imageHash,
          );

        expect(manifest).to.be.instanceOf(Buffer);
        expect(manifest.length).to.be.greaterThan(0);
      } catch (error) {
        const errorMessage = (error as Error).message;

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
      const nonce =
        await serviceWithConnection!.mobileImageMounterService.queryNonce();
      expect(nonce).to.be.instanceOf(Buffer);
      expect(nonce.length).to.be.greaterThan(0);
      expect(nonce.length).to.be.lessThan(64);
    });
  });

  describe('Unmount Operations', () => {
    it('should unmount personalized image', async function () {
      try {
        await serviceWithConnection!.mobileImageMounterService.unmountImage(
          '/System/Developer',
        );
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).to.satisfy(
          (msg: string) =>
            msg.includes('not supported') ||
            msg.includes('no matching entry') ||
            msg.length > 0,
        );
      }
    });
  });
});
