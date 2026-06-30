import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import { Services } from '../../src/index.js';
import type { DiagnosticsService } from '../../src/lib/types.js';
import { requireDeviceUdid } from './helpers/device.js';

describe('Diagnostics Service', { timeout: 60000 }, function () {
  let diagService: DiagnosticsService;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();

    diagService = await Services.startDiagnosticsService(udid);
  });

  after(async function () {
    // Discovery RSD is closed by startDiagnosticsService; no service-level close API.
  });

  it('should query power information using ioregistry', async function () {
    const info = (await diagService.ioregistry({
      ioClass: 'IOPMPowerSource',
      returnRawJson: true,
    })) as Record<string, any>;

    expect(info).to.be.an('object');
    expect(info.BatteryInstalled).to.equal(true);
  });
});
