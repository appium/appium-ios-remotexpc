import { logger } from '@appium/support';
import { expect } from 'chai';

import {
  PacketStreamClient,
  TunnelManager,
  tunnelApiClient,
} from '../../src/lib/tunnel/index.js';
import SyslogService from '../../src/services/ios/syslog-service/index.js';

const log = logger.getLogger('TunnelTest');

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let remoteXPC: any;
  let syslogService: SyslogService;
  let service: any;
  let packetStreamClient: PacketStreamClient | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    const tunnelExists = await tunnelApiClient.hasTunnel(udid);
    if (!tunnelExists) {
      throw new Error(
        `No tunnel found for device ${udid}. Please run the tunnel creation script first: npm run test:tunnel-creation`,
      );
    }

    const tunnelConnectionDetails =
      await tunnelApiClient.getTunnelConnection(udid);
    if (!tunnelConnectionDetails) {
      throw new Error(
        `Failed to get tunnel connection details for device ${udid}`,
      );
    }

    remoteXPC = await TunnelManager.createRemoteXPCConnection(
      tunnelConnectionDetails.host,
      tunnelConnectionDetails.port,
    );

    syslogService = new SyslogService([
      tunnelConnectionDetails.host,
      tunnelConnectionDetails.port,
    ]);

    const registryEntry = await tunnelApiClient.getTunnelByUdid(udid);
    if (registryEntry?.packetStreamPort) {
      log.info(
        `Packet stream server available on port ${registryEntry.packetStreamPort}`,
      );
      packetStreamClient = new PacketStreamClient(
        'localhost',
        registryEntry.packetStreamPort,
      );
      try {
        await packetStreamClient.connect();
        log.info('Connected to packet stream server');
      } catch (err) {
        log.warn(`Failed to connect to packet stream server: ${err}`);
        packetStreamClient = null;
      }
    } else {
      log.info(
        'No packet stream port found in registry. The tunnel creation script may need to be rerun.',
      );
    }
  });

  after(async function () {
    if (packetStreamClient) {
      await packetStreamClient.disconnect();
    }

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

  it('should start syslog service (requires active tunnel with packet source)', async function () {
    if (!packetStreamClient) {
      this.skip();
      return;
    }

    // Refresh the service object before using it
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;

    await syslogService.start(service, packetStreamClient, {
      pid: -1,
    });
    expect(true).to.be.true;
  });

  it('should capture and emit syslog messages (requires active tunnel with packet source)', async function () {
    if (!packetStreamClient) {
      this.skip();
      return;
    }

    // Refresh the service object before using it again
    service = remoteXPC.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;

    const messages: string[] = [];
    syslogService.on('message', (message: string) => {
      messages.push(message);
    });

    await syslogService.start(service, packetStreamClient, {
      pid: -1,
    });

    // Wait for a few seconds to collect messages
    await new Promise((resolve) => setTimeout(resolve, 3000));

    await syslogService.stop();

    expect(messages.length).to.be.greaterThan(0);
  });
});
