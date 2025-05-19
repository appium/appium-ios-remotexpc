import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { TunnelManager } from '../../src/lib/tunnel/index.js';
import DiagnosticsService from '../../src/services/ios/diagnostic-service/index.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let tunnelResult: TunnelConnection;
  let remoteXPC: any;
  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
    // Use TunnelManager to get or create a tunnel and RemoteXPC connection
    const result = await TunnelManager.createDeviceConnectionPair(udid, {});
    tunnelResult = result.tunnel;
    remoteXPC = result.remoteXPC;

    // List all services
    remoteXPC.listAllServices();

    // Find the diagnostics service
    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );

    // Create the diagnostics service
    diagService = new DiagnosticsService([
      tunnelResult.Address,
      parseInt(diagnosticsService.port, 10),
    ]);
  });

  after(async function () {
    // Close all tunnels when tests are done
    await TunnelManager.closeAllTunnels();
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
