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
  const udid = process.env.UDID || '';

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
      const maxAttempts = 150; // to ensure interface detection event is received

      for await (const event of networkMonitor.events()) {
        eventCount++;

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
      } else {
        log.warn('No interface detection events received within timeout');
      }
    });

    it('should receive connection detection events', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      let connectionEvent: NetworkEvent | null = null;
      let eventCount = 0;
      const maxAttempts = 30;

      for await (const event of networkMonitor.events()) {
        eventCount++;

        if (event.type === NetworkMessageType.CONNECTION_DETECTION) {
          connectionEvent = event;
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

    it('should receive connection update events', async () => {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      let updateEvent: NetworkEvent | null = null;
      let eventCount = 0;
      const maxAttempts = 100;

      for await (const event of networkMonitor.events()) {
        eventCount++;

        if (event.type === NetworkMessageType.CONNECTION_UPDATE) {
          updateEvent = event;
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
