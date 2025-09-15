import { logger } from '@appium/support';
import { expect } from 'chai';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { after, before, describe } from 'mocha';
import path from 'path';
import { fileURLToPath } from 'url';

import { Services } from '../../src/index.js';
import type { MobileImageMounterServiceWithConnection } from '../../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = logger.getLogger('MobileImageMounterService.test');
log.level = 'debug';

// Set the env var MOUNTER_IMAGE_DIR to a real fixtures directory containing Image.dmg, BuildManifest.plist and Image.trustcache/Image.dmg.trustcache
async function getFixturesInfo(): Promise<{
  isReal: boolean;
  fixturesDir: string;
}> {
  const realDir = process.env.MOUNTER_IMAGE_DIR;
  const stubDir = path.join(__dirname, '..', 'fixtures', 'stubs');

  const isReal =
    !!realDir &&
    (await fs
      .access(realDir)
      .then(() => true)
      .catch(() => false));

  const fixturesDir = isReal ? realDir! : stubDir;

  return { isReal, fixturesDir };
}

describe('MobileImageMounterService Integration', function () {
  this.timeout(40000);

  let serviceWithConnection: MobileImageMounterServiceWithConnection | null =
    null;
  const testUdid = process.env.UDID || '';

  before(async function () {
    if (!testUdid) {
      throw new Error('set UDID env var to execute tests.');
    }

    // Establish connection for all tests
    serviceWithConnection =
      await Services.startMobileImageMounterService(testUdid);
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
    it('should mount image', async function () {
      // Set env var MOUNTER_IMAGE_DIR
      const { isReal, fixturesDir } = await getFixturesInfo();

      const imagePath = path.join(fixturesDir, 'Image.dmg');
      const buildManifestPath = path.join(fixturesDir, 'BuildManifest.plist');

      // check for Image.trustcache or Image.dmg.trustcache
      let trustCachePath = path.join(fixturesDir, 'Image.trustcache');
      if (
        !(await fs
          .access(trustCachePath)
          .then(() => true)
          .catch(() => false))
      ) {
        trustCachePath = path.join(fixturesDir, 'Image.dmg.trustcache');
      }

      try {
        await serviceWithConnection!.mobileImageMounterService.mount(
          imagePath,
          buildManifestPath,
          trustCachePath,
        );

        if (isReal) {
          const mounted =
            await serviceWithConnection!.mobileImageMounterService.isPersonalizedImageMounted();
          expect(mounted).to.be.true;
        } else {
          console.warn('⚠️ Stub mount unexpectedly succeeded.');
        }
      } catch (err) {
        if (isReal) throw err;
        console.warn(
          `⚠️ Stub mount failed (expected). Error: ${(err as Error).message}`,
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
      log.debug(
        'Signatures:',
        signatures.map((s) => s.toString('hex')),
      );

      signatures.forEach((sig, index) => {
        expect(sig).to.be.instanceOf(Buffer);
        expect(sig.length).to.be.greaterThan(0);
      });
    });

    it('should check if personalized image is mounted', async function () {
      const isImageMounted =
        await serviceWithConnection!.mobileImageMounterService.isPersonalizedImageMounted();
      log.debug('Image mounted: ', isImageMounted);
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
      log.debug('Developer mode enabled: ', isDeveloperModeEnabled);
      expect(isDeveloperModeEnabled).to.be.a('boolean');
    });
  });

  describe('Personalization identifiers and manifest', () => {
    it('should query personalization identifiers only', async function () {
      const identifiers =
        await serviceWithConnection!.mobileImageMounterService.queryPersonalizationIdentifiers();
      log.debug('Personalization Identifier:', identifiers);
      expect(identifiers).to.be.an('object');
      expect(Object.keys(identifiers)).to.have.length.greaterThan(0);
    });

    it('should test queryPersonalizationManifest behavior', async function () {
      const mountedSignatures =
        await serviceWithConnection!.mobileImageMounterService.lookup();
      expect(mountedSignatures).to.be.an('array');

      if (mountedSignatures.length > 0) {
        for (const sig of mountedSignatures) {
          expect(sig).to.be.instanceOf(Buffer);
          expect(sig.length).to.be.greaterThan(0);

          try {
            const manifest =
              await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
                'DeveloperDiskImage',
                sig,
              );
            log.debug(
              'First 100 bytes of Manifest: ',
              manifest.toString('hex', 0, 100),
            );
            expect(manifest).to.be.instanceOf(Buffer);
            expect(manifest.length).to.be.greaterThan(0);
            return;
          } catch {}
        }
      }

      // If no mounted signatures, use local image hash
      const { isReal, fixturesDir } = await getFixturesInfo();

      const imageFilePath = path.join(fixturesDir, 'Image.dmg');
      const image = await fs.readFile(imageFilePath);
      const imageHash = createHash('sha384').update(image).digest();

      expect(imageHash).to.be.instanceOf(Buffer);
      expect(imageHash.length).to.equal(48); // SHA384 produces 48 bytes

      try {
        const manifest =
          await serviceWithConnection!.mobileImageMounterService.queryPersonalizationManifest(
            'DeveloperDiskImage',
            imageHash,
          );

        log.debug(
          'First 100 bytes of Manifest: ',
          manifest.toString('hex', 0, 100),
        );
        expect(manifest).to.be.instanceOf(Buffer);
        expect(manifest.length).to.be.greaterThan(0);
      } catch (err) {
        if (isReal) throw err;
        console.warn(
          `⚠️ Stub manifest query failed (expected). Error: ${(err as Error).message}`,
        );
      }
    });

    it('should query personalization nonce', async function () {
      const nonce =
        await serviceWithConnection!.mobileImageMounterService.queryNonce();
      log.debug('Personalization nonce:', nonce.toString('hex'));
      expect(nonce).to.be.instanceOf(Buffer);
      expect(nonce.length).to.be.greaterThan(0);
      expect(nonce.length).to.be.lessThan(64);
    });
  });

  describe('Unmount Operations', () => {
    it('should unmount personalized image', async function () {
      const { isReal } = await getFixturesInfo();

      try {
        await serviceWithConnection!.mobileImageMounterService.unmountImage();
        const isImageMounted =
          await serviceWithConnection!.mobileImageMounterService.isPersonalizedImageMounted();
        expect(isImageMounted).to.be.false;
      } catch (err) {
        if (isReal) throw err;
        console.warn(
          `⚠️ Stub unmount failed (expected). Error: ${(err as Error).message}`,
        );
      }
    });
  });
});
