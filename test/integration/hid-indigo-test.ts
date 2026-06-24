import { expect } from 'chai';

import type { HidIndigoService } from '../../src/index.js';
import * as Services from '../../src/services.js';

describe('HidIndigoService', function () {
  this.timeout(60000);

  let hidIndigoService: HidIndigoService | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }

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
