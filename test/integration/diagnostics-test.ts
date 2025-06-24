import { expect } from 'chai';

import { Services } from '../../src/index.js';
import type { DiagnosticsService } from '../../src/lib/types.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let remoteXPC: any;
  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
    diagService = await Services.startDiagnosticsService(udid);
  });

  after(async function () {
    // Close RemoteXPC connection
    if (remoteXPC) {
      try {
        await remoteXPC.close();
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

  it('should query power information using ioregistry', async function () {
    const rawInfo = await diagService.ioregistry({
      ioClass: 'IOPMPowerSource',
      returnRawJson: true,
    });
    expect(rawInfo).to.be.an('object');
  });

  it('should query wifi information using ioregistry ', async function () {
    const wifiInfo = await diagService.ioregistry({
      name: 'AppleBCMWLANSkywalkInterface',
      returnRawJson: true,
    });
    expect(wifiInfo).to.be.an('object');
  });
});
