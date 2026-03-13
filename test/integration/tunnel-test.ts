import { logger } from '@appium/support';
import { expect } from 'chai';

import {
  PacketStreamClient,
  TunnelManager,
} from '../../src/lib/tunnel/index.js';
import type { SyslogService as ISyslogService } from '../../src/lib/types.js';
import {
  createRemoteXPCConnection,
  startSyslogBinaryService,
  startSyslogTextService,
} from '../../src/services.js';

const log = logger.getLogger('TunnelTest');

const udid = process.env.UDID || '';

describe('Tunnel and Syslog Service', function () {
  this.timeout(60000);

  describe('os_trace_relay binary-mode (os_trace_relay.shim.remote)', function () {
    let syslogService: ISyslogService;
    let serviceDescriptor: any;
    let packetStreamClient: PacketStreamClient | null = null;

    before(async function () {
      ({ syslogService, serviceDescriptor } =
        await startSyslogBinaryService(udid));
      const { tunnelConnection } = await createRemoteXPCConnection(udid);
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

    it('should find os_trace_relay service', function () {
      expect(serviceDescriptor).to.not.be.undefined;
      expect(serviceDescriptor.port).to.be.a('string');
    });

    it('should start syslog service (requires active tunnel with packet source)', async function () {
      if (!packetStreamClient) {
        this.skip();
      }
      await syslogService.start(serviceDescriptor, packetStreamClient, {
        pid: -1,
      });
      expect(true).to.be.true;
    });

    it('should capture and emit syslog messages (requires active tunnel with packet source)', async function () {
      if (!packetStreamClient) {
        this.skip();
        return;
      }
      const messages: string[] = [];
      syslogService.on('message', (message: string) => {
        messages.push(message);
      });
      await syslogService.start(serviceDescriptor, packetStreamClient, {
        pid: -1,
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await syslogService.stop();
      expect(messages.length).to.be.greaterThan(0);
    });
  });

  describe('syslog_relay text-mode (syslog_relay.shim.remote)', function () {
    let syslogService: ISyslogService;
    let serviceDescriptor: any;

    before(async function () {
      ({ syslogService, serviceDescriptor } =
        await startSyslogTextService(udid));
    });

    after(async function () {
      await TunnelManager.closeAllTunnels();
    });

    afterEach(async function () {
      try {
        await syslogService.stop();
      } catch {}
    });

    it('should find syslog_relay service', function () {
      expect(serviceDescriptor).to.not.be.undefined;
      expect(serviceDescriptor.port).to.be.a('string');
    });

    it('should start in text mode without error', async function () {
      await syslogService.start(
        serviceDescriptor,
        { addPacketConsumer: () => {}, removePacketConsumer: () => {} },
        { pid: -1, textMode: true },
      );
    });

    it('should stop cleanly', async function () {
      await syslogService.start(
        serviceDescriptor,
        { addPacketConsumer: () => {}, removePacketConsumer: () => {} },
        { pid: -1, textMode: true },
      );
      await syslogService.stop();
    });
  });
});
