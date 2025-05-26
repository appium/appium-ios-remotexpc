import { expect } from 'chai';

import {
  TunnelManager,
  getTunnelByUdid,
  getTunnelConnection,
  hasTunnel,
} from '../../src/lib/tunnel/index.js';
import SyslogService from '../../src/services/ios/syslog-service/index.js';

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let tunnelAddress: string;
  let tunnelPort: number;
  let remoteXPC: any;
  let syslogService: SyslogService;
  let service: any;
  const udid = process.env.UDID || '';

  before(async function () {
    // Check if tunnel exists in registry for this device
    const tunnelExists = await hasTunnel(udid);
    if (!tunnelExists) {
      throw new Error(
        `No tunnel found for device ${udid}. Please run the tunnel creation script first: npm run test:tunnel-creation`,
      );
    }

    // Get tunnel connection details from registry
    const tunnelConnection = await getTunnelConnection(udid);
    if (!tunnelConnection) {
      throw new Error(
        `Failed to get tunnel connection details for device ${udid}`,
      );
    }

    // Get tunnel registry entry for additional details
    const tunnelEntry = await getTunnelByUdid(udid);
    if (!tunnelEntry) {
      throw new Error(`Failed to get tunnel entry for device ${udid}`);
    }

    // Store tunnel connection details
    tunnelAddress = tunnelConnection.host;
    tunnelPort = tunnelConnection.port;

    // Create RemoteXPC connection using tunnel registry data
    remoteXPC = await TunnelManager.createRemoteXPCConnection(
      tunnelConnection.host,
      tunnelConnection.port,
    );

    // Connect to RemoteXPC
    await remoteXPC.connect();

    // Initialize syslog service
    syslogService = new SyslogService([
      tunnelConnection.host,
      tunnelConnection.port,
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

    // Close syslog service if needed
    if (syslogService) {
      try {
        await syslogService.stop();
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

  it('should list all services', function () {
    const services = remoteXPC.getServices();
    expect(services).to.be.an('array');
  });

  it('should find os_trace_relay service', function () {
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;
  });

  it('should connect to tunnel using registry data', function () {
    // Verify we have valid tunnel connection data
    expect(tunnelAddress).to.be.a('string');
    expect(tunnelPort).to.be.a('number');
    expect(tunnelPort).to.be.greaterThan(0);
  });

  it('should have RemoteXPC connection', function () {
    // Verify RemoteXPC connection is established
    expect(remoteXPC).to.not.be.undefined;
    expect(remoteXPC.isConnected()).to.be.true;
  });

  // Note: Syslog tests are skipped because they require a TunnelManager instance
  // which is not available when using the tunnel registry approach.
  // The syslog service needs the actual tunnel manager for packet capture.
  it.skip('should start syslog service (requires TunnelManager)', async function () {
    // This test is skipped because syslog service requires a TunnelManager
    // instance for packet capture, which is not available when using
    // the tunnel registry approach.
  });

  it.skip('should capture and emit syslog messages (requires TunnelManager)', async function () {
    // This test is skipped because syslog service requires a TunnelManager
    // instance for packet capture, which is not available when using
    // the tunnel registry approach.
  });
});
