import { logger } from '@appium/support';
import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import type { DVTInstruments } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { requireDeviceUdid } from './helpers/device.js';

const log = logger.getLogger('DVTService.test');
log.level = 'debug';

describe('DVT Service Connection', { timeout: 30000 }, function () {
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

  it('should connect to DVT service and get supported identifiers/instruments', async () => {
    expect(dvtServiceConnection).to.not.be.null;
    expect(dvtServiceConnection!.dvtService).to.not.be.null;
    expect(dvtServiceConnection!.locationSimulation).to.not.be.null;

    const supportedIdentifiers =
      dvtServiceConnection!.dvtService.getSupportedIdentifiers();
    expect(supportedIdentifiers).to.be.an('object');
    expect(Object.keys(supportedIdentifiers).length).to.be.greaterThan(0);

    // Verify location simulation is supported
    const hasLocationSimulation = Object.keys(supportedIdentifiers).some(
      (key) => key.includes('LocationSimulation'),
    );
    expect(hasLocationSimulation).to.be.true;
  });
});
