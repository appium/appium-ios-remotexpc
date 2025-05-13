import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { createLockdownServiceByUDID } from '../../src/lib/lockdown/index.js';
import RemoteXpcConnection from '../../src/lib/remote-xpc/remote-xpc-connection.js';
import TunnelManager from '../../src/lib/tunnel/index.js';
import SyslogService from '../../src/services/ios/syslog-service/index.js';
import { startCoreDeviceProxy } from '../../src/services/ios/tunnel-service/index.js';

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  const tunManager = TunnelManager;
  let tunnelResult: TunnelConnection;
  let remoteXPC: RemoteXpcConnection;
  let syslogService: SyslogService;
  let service: any;
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

    // Fix: Check if RsdPort is defined and provide a fallback value if it's undefined
    const rsdPort = tunnelResult.RsdPort ?? 0; // Using nullish coalescing operator

    remoteXPC = new RemoteXpcConnection([tunnelResult.Address, rsdPort]);
    await remoteXPC.connect();

    // Initialize syslog service
    syslogService = new SyslogService([tunnelResult.Address, rsdPort]);
  });

  after(async function () {
    if (tunManager) {
      await tunManager.closeTunnel();
    }
  });

  it('should list all services', function () {
    remoteXPC.listAllServices();
    const services = remoteXPC.getServices();
    expect(services).to.be.an('array');
  });

  it('should find os_trace_relay service', function () {
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;
  });

  it('should start syslog service', async function () {
    await syslogService.start(service, tunnelResult.tunnelManager, {
      pid: -1,
    });
    // If no error is thrown, the test passes
    expect(true).to.be.true;
  });

  it('should capture and emit syslog messages', async function () {
    const messages: string[] = [];
    syslogService.on('message', (message: string) => {
      messages.push(message);
    });

    // Start capturing
    await syslogService.start(service, tunnelResult.tunnelManager, {
      pid: -1,
    });

    // Wait for a few seconds to collect messages
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Stop capturing
    await syslogService.stop();

    // Verify that we captured some messages
    expect(messages.length).to.be.greaterThan(0);
  });
});
