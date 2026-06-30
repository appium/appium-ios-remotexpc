import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

import type {MobileConfigService} from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('MobileConfigService.test');
// Set MobileConfigService logger to info level
log.level = 'info';

describe('MobileConfigService', {timeout: 60000}, function () {
  let mobileConfigService: MobileConfigService;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();

    mobileConfigService = await Services.startMobileConfigService(udid);
  });

  after(async function () {});

  it('get profile list', async function () {
    try {
      const profiles = await mobileConfigService.getProfileList();
      expect(profiles).to.be.an('object');
      expect(profiles).to.not.deep.equal({});
      expect(profiles.Status).to.be.equal('Acknowledged');
      log.info(profiles);
    } catch (error) {
      log.error('Error getting listed profiles:', (error as Error).message);
      throw error;
    }
  });

  it('install profile', async function () {
    try {
      // Make sure to provide a valid .mobileconfig file path
      await mobileConfigService.installProfileFromPath('pathto/your.mobileconfig');
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
