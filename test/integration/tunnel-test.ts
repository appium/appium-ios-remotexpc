import { logger } from '@appium/support';
import { expect } from 'chai';

import {
  PacketStreamClient,
  TunnelManager,
} from '../../src/lib/tunnel/index.js';
import type { SyslogService } from '../../src/lib/types.js';
import {
  createRemoteXPCConnection,
  startSyslogService,
} from '../../src/services.js';

const log = logger.getLogger('TunnelTest');

describe('Tunnel and Syslog Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let remoteXpc: any;
  let syslogService: SyslogService;
  let service: any;
  let packetStreamClient: PacketStreamClient | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    const { remoteXPC, tunnelConnection } =
      await createRemoteXPCConnection(udid);
    remoteXpc = remoteXPC;
    packetStreamClient = new PacketStreamClient(
      'localhost',
      tunnelConnection.packetStreamPort,
    );
    try {
      await packetStreamClient.connect();
      log.info('Connected to packet stream server');
    } catch (err) {
      log.warn(`Failed to connect to packet stream server: ${err}`);
      packetStreamClient = null;
    }
  });

  after(async function () {
    if (packetStreamClient) {
      await packetStreamClient.disconnect();
    }

    await TunnelManager.closeAllTunnels();
  });

  it('should list all services', function () {
    const services = remoteXpc.getServices();
    expect(services).to.be.an('array');
  });

  it('should find os_trace_relay service', function () {
    service = remoteXpc.findService('com.apple.os_trace_relay.shim.remote');
    expect(service).to.not.be.undefined;
  });

  it('should start syslog service (requires active tunnel with packet source)', async function () {
    syslogService = await startSyslogService(udid);
    if (!packetStreamClient) {
      this.skip();
      return;
    }

    // Refresh the service object before using it
    service = remoteXpc.findService('com.apple.os_trace_relay.shim.remote');
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
    service = remoteXpc.findService('com.apple.os_trace_relay.shim.remote');
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
