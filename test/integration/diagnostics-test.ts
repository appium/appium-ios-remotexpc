import { Services } from '../../src/index.js';
import type { DiagnosticsService } from '../../src/lib/types.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
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
