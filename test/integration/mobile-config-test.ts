import { logger } from '@appium/support';


import type { MobileConfigService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import { expect } from 'chai';

const log = logger.getLogger('MobileConfigService.test');
// Set MobileConfigService logger to info level
log.level = 'info';

describe('MobileConfigService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let mobileConfigService: MobileConfigService;
  const udid = process.env.UDID || '00008030-000318693E32402E';

  before(async function () {
    const result = await Services.startMobileConfigService(udid);
    mobileConfigService = result.mobileConfigService;
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

  it('get profile list', async function () {
    try {
      const profiles = await mobileConfigService.getProfileList();
      expect(profiles).to.be.an('object');
      expect(profiles).to.not.deep.equal({});
      expect(profiles.Status).to.be.equal('Acknowledged');
      console.log(profiles);
    } catch (error) {
      log.error('Error getting listed profiles:', (error as Error).message);
      throw error;
    }
  });

  it('install profile', async function () {
    try {
      await mobileConfigService.installProfile('/Users/swastikb/Downloads/test.mobileconfig');
      // This only installs on the iPhone, to use it must be installed manually
    } catch (error) {
      log.error('Error while installing profile:', (error as Error).message);
      throw error;
    }
  });

  it('delete profile', async function () {
    try {
      await mobileConfigService.removeProfile('com.example.testprofile');
    } catch (error) {
      log.error('Error while removing profile:', (error as Error).message);
      throw error;
    }
  });
});