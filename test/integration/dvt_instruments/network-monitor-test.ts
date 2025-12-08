import { logger } from '@appium/support';
import { expect } from 'chai';

import type {
  DVTServiceWithConnection,
  NetworkEvent,
} from '../../../src/index.js';
import { NetworkMessageType } from '../../../src/index.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('NetworkMonitor.test');
log.level = 'debug';

describe('NetworkMonitor', function () {
  this.timeout(60000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  describe('Network Monitoring', () => {
    it('should receive network events through async iterator', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      const events: NetworkEvent[] = [];
      const maxEvents = 10;

      for await (const event of networkMonitor.events()) {
        // log.info('Network event:', JSON.stringify(event, null, 2));
        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }

      expect(events).to.have.length.at.least(1);

      for (const event of events) {
        expect(event).to.exist;
        expect(event).to.have.property('type');
        expect([
          NetworkMessageType.INTERFACE_DETECTION,
          NetworkMessageType.CONNECTION_DETECTION,
          NetworkMessageType.CONNECTION_UPDATE,
        ]).to.include(event.type);
      }
    });

    it('should receive interface detection events', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      let interfaceEvent: NetworkEvent | null = null;
      let eventCount = 0;
      const maxAttempts = 150;

      for await (const event of networkMonitor.events()) {
        eventCount++;
        // log.debug(`Event ${eventCount}:`, JSON.stringify(event));

        if (event.type === NetworkMessageType.INTERFACE_DETECTION) {
          interfaceEvent = event;
          break;
        }

        if (eventCount >= maxAttempts) {
          break;
        }
      }

      if (interfaceEvent) {
        expect(interfaceEvent.type).to.equal(
          NetworkMessageType.INTERFACE_DETECTION,
        );
        expect(interfaceEvent).to.have.property('interfaceIndex');
        expect(interfaceEvent).to.have.property('name');
        log.info(
          `Interface detected: ${interfaceEvent.name} (index: ${interfaceEvent.interfaceIndex})`,
        );
      } else {
        log.warn('No interface detection events received within timeout');
      }
    });

    it('should receive connection detection events with address info', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      let connectionEvent: NetworkEvent | null = null;
      let eventCount = 0;
      const maxAttempts = 30;

      log.info(
        'Waiting for connection events - ensure device has network activity',
      );

      for await (const event of networkMonitor.events()) {
        log.debug(`Event ${eventCount}:`, JSON.stringify(event));
        eventCount++;

        if (event.type === NetworkMessageType.CONNECTION_DETECTION) {
          connectionEvent = event;
          log.info(
            `Connection detected: ${event.localAddress.address}:${event.localAddress.port} -> ` +
              `${event.remoteAddress.address}:${event.remoteAddress.port} (PID: ${event.pid})`,
          );
          break;
        }

        if (eventCount >= maxAttempts) {
          break;
        }
      }

      if (
        connectionEvent &&
        connectionEvent.type === NetworkMessageType.CONNECTION_DETECTION
      ) {
        expect(connectionEvent.localAddress).to.have.property('address');
        expect(connectionEvent.localAddress).to.have.property('port');
        expect(connectionEvent.remoteAddress).to.have.property('address');
        expect(connectionEvent.remoteAddress).to.have.property('port');
        expect(connectionEvent).to.have.property('pid');
        expect(connectionEvent).to.have.property('interfaceIndex');
      } else {
        log.warn('No connection detection events received within timeout');
      }
    });

    it('should receive connection update events with statistics', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      let updateEvent: NetworkEvent | null = null;
      let eventCount = 0;
      const maxAttempts = 500;

      log.info(
        'Waiting for connection update events - ensure device has active network traffic',
      );

      for await (const event of networkMonitor.events()) {
        eventCount++;

        if (event.type === NetworkMessageType.CONNECTION_UPDATE) {
          updateEvent = event;
          log.debug(`Event ${eventCount}:`, JSON.stringify(event));
          log.info(
            `Connection update: serial=${event.connectionSerial}, ` +
              `rx=${event.rxBytes} bytes, tx=${event.txBytes} bytes`,
          );
          break;
        }

        if (eventCount >= maxAttempts) {
          break;
        }
      }

      if (
        updateEvent &&
        updateEvent.type === NetworkMessageType.CONNECTION_UPDATE
      ) {
        expect(updateEvent).to.have.property('rxPackets');
        expect(updateEvent).to.have.property('rxBytes');
        expect(updateEvent).to.have.property('txPackets');
        expect(updateEvent).to.have.property('txBytes');
        expect(updateEvent).to.have.property('connectionSerial');
        expect(updateEvent).to.have.property('time');
      } else {
        log.warn('No connection update events received within timeout');
      }
    });
  });
});
