import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../../src/index.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('AppList.test');
log.level = 'debug';

describe('Application Listing', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
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
