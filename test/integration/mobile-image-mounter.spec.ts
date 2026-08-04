import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {logger, node} from '@appium/support';

import {Services} from '../../src/index.js';
import type {MobileImageMounterService} from '../../src/index.js';
import {requireDeviceUdid} from './helpers/device.js';

const PKG_ROOT = node.getModuleRootSync('appium-ios-remotexpc', fileURLToPath(import.meta.url));

const log = logger.getLogger('MobileImageMounterService.test');
log.level = 'debug';

// Set the env var MOUNTER_IMAGE_DIR to a real fixtures directory containing Image.dmg, BuildManifest.plist and Image.trustcache/Image.dmg.trustcache
async function getFixturesInfo(): Promise<{
  isReal: boolean;
  fixturesDir: string;
}> {
  const realDir = process.env.MOUNTER_IMAGE_DIR;
  const stubDir = path.join(PKG_ROOT, 'test', 'fixtures', 'stubs');

  const isReal =
    !!realDir &&
    (await fs
      .access(realDir)
      .then(() => true)
      .catch(() => false));

  const fixturesDir = isReal ? realDir! : stubDir;

  return {isReal, fixturesDir};
}

describe('MobileImageMounterService Integration', {timeout: 40000}, function () {
  let mobileImageMounterService: MobileImageMounterService | null = null;
  let testUdid: string;

  before(async function () {
    testUdid = requireDeviceUdid();

    // Establish connection for all tests
    mobileImageMounterService = await Services.startMobileImageMounterService(testUdid);
  });

  after(async function () {});

  describe('Service Connection', () => {
    it('should connect to mobile image mounter service', async function () {
      assert.notStrictEqual(mobileImageMounterService, null);
    });
  });

  describe('Mount Operations', () => {
    it('should mount image', async function () {
      // Set env var MOUNTER_IMAGE_DIR
      const {isReal, fixturesDir} = await getFixturesInfo();

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
        await mobileImageMounterService!.mount(imagePath, buildManifestPath, trustCachePath);

        if (isReal) {
          const mounted = await mobileImageMounterService!.isPersonalizedImageMounted();
          assert.strictEqual(mounted, true);
        } else {
          log.warn('⚠️ Stub mount unexpectedly succeeded.');
        }
      } catch (err) {
        if (isReal) {
          throw err;
        }
        log.warn(`⚠️ Stub mount failed (expected). Error: ${(err as Error).message}`);
      }
    });
  });

  describe('Image Lookup Operations', () => {
    it('should lookup mounted personalized images', async function () {
      const signatures = await mobileImageMounterService!.lookup('Personalized');
      assert.ok(Array.isArray(signatures));
      log.debug(
        'Signatures:',
        signatures.map((s) => s.toString('hex')),
      );

      signatures.forEach((sig) => {
        assert.ok(sig instanceof Buffer);
        assert.ok(sig.length > 0);
      });
    });

    it('should check if personalized image is mounted', async function () {
      const isImageMounted = await mobileImageMounterService!.isPersonalizedImageMounted();
      log.debug('Image mounted: ', isImageMounted);
      assert.ok(typeof isImageMounted === 'boolean');
    });

    it('should copy devices list', async function () {
      const devices = await mobileImageMounterService!.copyDevices();
      assert.ok(Array.isArray(devices));
    });
  });

  describe('Developer Mode Status', () => {
    it('should query developer mode status', async function () {
      const isDeveloperModeEnabled = await mobileImageMounterService!.queryDeveloperModeStatus();
      log.debug('Developer mode enabled: ', isDeveloperModeEnabled);
      assert.ok(typeof isDeveloperModeEnabled === 'boolean');
    });
  });

  describe('Personalization identifiers and manifest', () => {
    it('should query personalization identifiers only', async function () {
      const identifiers = await mobileImageMounterService!.queryPersonalizationIdentifiers();
      log.debug('Personalization Identifier:', identifiers);
      assert.ok(typeof identifiers === 'object' && identifiers !== null && !Array.isArray(identifiers));
      assert.ok(Object.keys(identifiers).length > 0);
    });

    it('should test queryPersonalizationManifest behavior', async function () {
      const mountedSignatures = await mobileImageMounterService!.lookup();
      assert.ok(Array.isArray(mountedSignatures));

      if (mountedSignatures.length > 0) {
        for (const sig of mountedSignatures) {
          assert.ok(sig instanceof Buffer);
          assert.ok(sig.length > 0);

          try {
            const manifest = await mobileImageMounterService!.queryPersonalizationManifest('DeveloperDiskImage', sig);
            log.debug('First 100 bytes of Manifest: ', manifest.toString('hex', 0, 100));
            assert.ok(manifest instanceof Buffer);
            assert.ok(manifest.length > 0);
            return;
          } catch {}
        }
      }

      // If no mounted signatures, use local image hash
      const {isReal, fixturesDir} = await getFixturesInfo();

      const imageFilePath = path.join(fixturesDir, 'Image.dmg');
      const image = await fs.readFile(imageFilePath);
      const imageHash = createHash('sha384').update(image).digest();

      assert.ok(imageHash instanceof Buffer);
      assert.strictEqual(imageHash.length, 48); // SHA384 produces 48 bytes

      try {
        const manifest = await mobileImageMounterService!.queryPersonalizationManifest('DeveloperDiskImage', imageHash);

        log.debug('First 100 bytes of Manifest: ', manifest.toString('hex', 0, 100));
        assert.ok(manifest instanceof Buffer);
        assert.ok(manifest.length > 0);
      } catch (err) {
        if (isReal) {
          throw err;
        }
        log.warn(`⚠️ Stub manifest query failed (expected). Error: ${(err as Error).message}`);
      }
    });

    it('should query personalization nonce', async function () {
      const nonce = await mobileImageMounterService!.queryNonce();
      log.debug('Personalization nonce:', nonce.toString('hex'));
      assert.ok(nonce instanceof Buffer);
      assert.ok(nonce.length > 0);
      assert.ok(nonce.length < 64);
    });
  });

  describe('Unmount Operations', () => {
    it('should unmount personalized image', async function () {
      const {isReal} = await getFixturesInfo();

      try {
        await mobileImageMounterService!.unmountImage();
        const isImageMounted = await mobileImageMounterService!.isPersonalizedImageMounted();
        assert.strictEqual(isImageMounted, false);
      } catch (err) {
        if (isReal) {
          throw err;
        }
        log.warn(`⚠️ Stub unmount failed (expected). Error: ${(err as Error).message}`);
      }
    });
  });
});
