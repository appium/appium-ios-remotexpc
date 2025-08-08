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
    let { diagnosticsService, remoteXPC } =
      await Services.startDiagnosticsService(udid);
    diagService = diagnosticsService;
    remoteXPC = remoteXPC;
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
    console.log(rawInfo);
    expect(rawInfo).to.be.an('object');
  });

  it('should query wifi information using ioregistry ', async function () {
    const wifiInfo = await diagService.ioregistry({
      name: 'AppleBCMWLANSkywalkInterface',
      returnRawJson: true,
    });
    console.log(wifiInfo);
    expect(wifiInfo).to.be.an('object');
  });
});
