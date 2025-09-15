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
  const udid = process.env.UDID || '';

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
    } catch (error) {
      log.error('Error getting listed profiles:', (error as Error).message);
      throw error;
    }
  });

  it('install profile', async function () {
    try {
      // Make sure to provide a valid .mobileconfig file path
      await mobileConfigService.installProfile('pathto/your.mobileconfig');
      // This only installs on the iPhone, to use it must be installed manually
    } catch (error) {
      log.error('Error while installing profile:', (error as Error).message);
      throw error;
    }
  });

  it('remove profile', async function () {
    try {
      // Identifier is found in the profile list under ProfileMetadata key
      await mobileConfigService.removeProfile('com.xxx.yyy');
    } catch (error) {
      log.error('Error while removing profile:', (error as Error).message);
      throw error;
    }
  });
});
