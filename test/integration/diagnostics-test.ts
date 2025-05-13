import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { createLockdownServiceByUDID } from '../../src/lib/lockdown/index.js';
import RemoteXpcConnection from '../../src/lib/remote-xpc/remote-xpc-connection.js';
import TunnelManager from '../../src/lib/tunnel/index.js';
import DiagnosticsService from '../../src/services/ios/diagnostic-service/index.js';
import { startCoreDeviceProxy } from '../../src/services/ios/tunnel-service/index.js';

describe('Diagnostics Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  let remoteXPC: RemoteXpcConnection;
  let diagService: DiagnosticsService;
  const udid = process.env.UDID || '';

  before(async function () {
    const { lockdownService, device } = await createLockdownServiceByUDID(udid);
    const { socket } = await startCoreDeviceProxy(
      lockdownService,
      device.DeviceID,
      device.Properties.SerialNumber,
      {},
    );

    tunnelResult = await tunManager.getTunnel(socket);
    const rsdPort = tunnelResult.RsdPort ?? 0;

    remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();
    remoteXPC.listAllServices();

    const diagnosticsService = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );

    diagService = new DiagnosticsService([
      tunnelResult.Address,
      parseInt(diagnosticsService.port, 10),
    ]);
  });

  after(async function () {
    if (tunManager) {
      await tunManager.closeTunnel();
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
