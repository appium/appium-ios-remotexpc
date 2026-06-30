import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

import type {DVTInstruments} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('AppList.test');
log.level = 'debug';

describe('Application Listing', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async () => {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
    }
  });

  describe('List apps', () => {
    it('list all applications', async () => {
      const list = await dvtServiceConnection!.appListing.list();
      expect(list).to.be.an('array');
      expect(list).to.not.be.empty;

      expect(list.length).to.greaterThan(0);
      list.forEach((app) => {
        expect(app).to.have.property('CFBundleIdentifier');
        expect(app).to.have.property('DisplayName');
        expect(app).to.have.property('BundlePath');
      });
    });
  });
});
