import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {DVTInstruments} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('DVTService.test');
log.level = 'debug';

describe('DVT Service Connection', {timeout: 30000}, function () {
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
    assert.notStrictEqual(dvtServiceConnection, null);
    assert.notStrictEqual(dvtServiceConnection!.dvtService, null);
    assert.notStrictEqual(dvtServiceConnection!.locationSimulation, null);

    const supportedIdentifiers = dvtServiceConnection!.dvtService.getSupportedIdentifiers();
    assert.ok(
      typeof supportedIdentifiers === 'object' && supportedIdentifiers !== null && !Array.isArray(supportedIdentifiers),
    );
    assert.ok(Object.keys(supportedIdentifiers).length > 0);

    // Verify location simulation is supported
    const hasLocationSimulation = Object.keys(supportedIdentifiers).some((key) => key.includes('LocationSimulation'));
    assert.strictEqual(hasLocationSimulation, true);
  });
});
