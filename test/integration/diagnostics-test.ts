import { expect } from 'chai';

import { TunnelManager, tunnelApiClient } from '../../src/lib/tunnel/index.js';
import DiagnosticsService from '../../src/services/ios/diagnostic-service/index.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let remoteXPC: any;
  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
    // Check if tunnel exists in registry for this device
    const tunnelExists = await tunnelApiClient.hasTunnel(udid);
    if (!tunnelExists) {
      throw new Error(
        `No tunnel found for device ${udid}. Please run the tunnel creation script first: npm run test:tunnel-creation`,
      );
    }

    // Get tunnel connection details from registry
    const tunnelConnection = await tunnelApiClient.getTunnelConnection(udid);
    if (!tunnelConnection) {
      throw new Error(
        `Failed to get tunnel connection details for device ${udid}`,
      );
    }

    // Create RemoteXPC connection using tunnel registry data
    remoteXPC = await TunnelManager.createRemoteXPCConnection(
      tunnelConnection.host,
      tunnelConnection.port,
    );

    // List all services
    remoteXPC.listAllServices();

    // Find the diagnostics service
    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );

    // Create the diagnostics service
    if (!diagnosticsService) {
      throw new Error(
        `Diagnostics service '${DiagnosticsService.RSD_SERVICE_NAME}' not found`,
      );
    }

    // Create the diagnostics service
    diagService = new DiagnosticsService([
      tunnelConnection.host,
      parseInt(diagnosticsService.port, 10),
    ]);
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
