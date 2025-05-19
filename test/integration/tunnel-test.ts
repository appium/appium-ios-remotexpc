import { expect } from 'chai';
import type { TunnelConnection } from 'tuntap-bridge';

import { TunnelManager } from '../../src/lib/tunnel/index.js';
import SyslogService from '../../src/services/ios/syslog-service/index.js';

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let tunnelResult: TunnelConnection;
  let remoteXPC: any;
  let syslogService: SyslogService;
  let service: any;
  const udid = process.env.UDID || '';

  before(async function () {
    // Use TunnelManager to get or create a tunnel and RemoteXPC connection
    const result = await TunnelManager.createDeviceConnectionPair(udid, {});
    tunnelResult = result.tunnel;
    remoteXPC = result.remoteXPC;

    // Initialize syslog service
    const rsdPort = tunnelResult.RsdPort ?? 0;
    syslogService = new SyslogService([tunnelResult.Address, rsdPort]);
  });

  after(async function () {
    // Close all tunnels when tests are done
    await TunnelManager.closeAllTunnels();
  });

  it('should list all services', function () {
    const services = remoteXPC.getServices();
    expect(services).to.be.an('array');
  });

  it('should find os_trace_relay service', function () {
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;
  });

  it('should start syslog service', async function () {
    // Refresh the service object before using it
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;

    await syslogService.start(service, tunnelResult.tunnelManager, {
      pid: -1,
    });
    // If no error is thrown, the test passes
    expect(true).to.be.true;
  });

  it('should capture and emit syslog messages', async function () {
    // Refresh the service object before using it again
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;

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
