import { logger } from '@appium/support';
import { expect } from 'chai';

import { type MisagentService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('MisagentService.test');
log.level = 'info';

describe('MisagentService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let misagentService: MisagentService;
  const udid = process.env.UDID || '';

  before(async function () {
    const result = await Services.startMisagentService(udid);
    misagentService = result.misagentService;
    remoteXPC = result.remoteXPC;
  });

  after(async function () {
    if (remoteXPC) {
      try {
        await remoteXPC.close();
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

  describe('installProfile', function () {
    it('should install a valid provisioning profile', async function () {
      try {
        // Make sure to provide a valid .mobileprovision file path
        await misagentService.installProfileFromPath(
          'pathto/your.mobileprovision',
        );
      } catch (error) {
        log.error('Error installing profile:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('copyAll', function () {
    it('should copy all installed profiles', async function () {
      try {
        const res = await misagentService.copyAll();
        log.info('CopyAll response:', JSON.stringify(res, null, 2));
        expect(res).to.be.an('array');
        res.forEach((profile) => {
          expect(profile.plist.UUID).to.be.a('string');
          expect(profile.plist.TeamName).to.be.a('string');
          expect(profile.plist.Version).to.be.a('number');
        });
      } catch (error) {
        log.error('Error copying profiles:', (error as Error).message);
        throw error;
      }
    });
  });

  describe('removeProfile', function () {
    it('should remove an installed profile', async function () {
      try {
        // Use a valid UUID from the installed profiles
        await misagentService.removeProfile(
          '12345678-90AB-CDEF-1234-567890ABCDEF',
        );
      } catch (error) {
        log.error('Error removing profile:', (error as Error).message);
        throw error;
      }
    });
  });
});
