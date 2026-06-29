import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import type { HidIndigoService } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { requireDeviceUdid } from './helpers/device.js';

describe('HidIndigoService', { timeout: 60000 }, function () {
  let hidIndigoService: HidIndigoService | null = null;
  const udid = requireDeviceUdid();

  before(async function () {
    hidIndigoService = await Services.startHidIndigoService(udid);
  });

  after(async function () {
    try {
      await hidIndigoService?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('should start the service and dispatch a home button press', async function () {
    expect(hidIndigoService).to.not.be.null;

    await hidIndigoService!.pressButton('home', { holdSeconds: 2 });
  });

  it('should dispatch a double home button press sequence', async function () {
    expect(hidIndigoService).to.not.be.null;

    await hidIndigoService!.pressButton('home', {
      holdSeconds: 0.05,
      pressCount: 2,
    });
  });
});
