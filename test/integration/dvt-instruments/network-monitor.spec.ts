import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {DVTInstruments, NetworkEvent} from '../../../src/index.js';
import {NetworkMessageType} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('NetworkMonitor.test');
log.level = 'debug';

async function findEventOfType<K extends NetworkEvent['type']>(
  networkMonitor: any,
  eventType: K,
  maxAttempts: number = 50,
  timeoutMs: number = 10000,
): Promise<Extract<NetworkEvent, {type: K}>> {
  const startTime = Date.now();
  let eventCount = 0;

  for await (const event of networkMonitor.events()) {
    if (event.type === eventType) {
      return event as Extract<NetworkEvent, {type: K}>;
    }

    eventCount++;
    if (eventCount >= maxAttempts || Date.now() - startTime > timeoutMs) {
      throw new Error(`Failed to receive ${eventType} event within ${maxAttempts} attempts or ${timeoutMs}ms timeout`);
    }
  }

  throw new Error(`Event stream ended without receiving ${eventType} event`);
}

describe('NetworkMonitor', {timeout: 60000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async function () {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
    }
  });

  // When running the tests, perform some network activity on the device like opening Safari and navigating to a website.
  // Some event types may take time to be received, increase maxAttempts and timeoutMs accordingly.
  describe('Network Monitoring', function () {
    it('should stop an active iterator without waiting for new events', async function () {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      const iterator = networkMonitor.events();

      // Start stream consumption so the iterator blocks in receivePlist().
      const nextPromise = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await networkMonitor.stop();

      const result = await Promise.race([
        nextPromise,
        new Promise<IteratorResult<NetworkEvent>>((resolve, reject) =>
          setTimeout(() => reject(new Error('Network monitor iterator did not stop after stopMonitoring')), 5000),
        ),
      ]);

      if (!result.done) {
        const terminalResult = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<NetworkEvent>>((resolve, reject) =>
            setTimeout(
              () => reject(new Error('Network monitor iterator did not terminate after stopMonitoring')),
              5000,
            ),
          ),
        ]);
        assert.strictEqual(terminalResult.done, true);
      } else {
        assert.strictEqual(result.done, true);
      }
    });

    it('should receive network events through async iterator', async function () {
      const networkMonitor = dvtServiceConnection!.networkMonitor;
      const events: NetworkEvent[] = [];
      const maxEvents = 10;

      for await (const event of networkMonitor.events()) {
        events.push(event);

        if (events.length >= maxEvents) {
          break;
        }
      }

      assert.ok(events.length >= 1);

      for (const event of events) {
        assert.ok(event !== null && event !== undefined);
        assert.ok('type' in event);
        assert.ok(
          [
            NetworkMessageType.INTERFACE_DETECTION,
            NetworkMessageType.CONNECTION_DETECTION,
            NetworkMessageType.CONNECTION_UPDATE,
          ].includes(event.type),
        );
      }
    });

    it('should receive interface detection events', async function () {
      const networkMonitor = dvtServiceConnection!.networkMonitor;

      const interfaceEvent = await findEventOfType(networkMonitor, NetworkMessageType.INTERFACE_DETECTION, 250);

      assert.strictEqual(interfaceEvent.type, NetworkMessageType.INTERFACE_DETECTION);
      assert.ok('interfaceIndex' in interfaceEvent);
      assert.ok('name' in interfaceEvent);
    });

    it('should receive connection detection events', async function () {
      const networkMonitor = dvtServiceConnection!.networkMonitor;

      const connectionEvent = await findEventOfType(networkMonitor, NetworkMessageType.CONNECTION_DETECTION, 30);

      assert.ok('address' in connectionEvent.localAddress);
      assert.ok('port' in connectionEvent.localAddress);
      assert.ok('address' in connectionEvent.remoteAddress);
      assert.ok('port' in connectionEvent.remoteAddress);
      assert.ok('pid' in connectionEvent);
      assert.ok('interfaceIndex' in connectionEvent);
    });

    it('should receive connection update events', async function () {
      const networkMonitor = dvtServiceConnection!.networkMonitor;

      const updateEvent = await findEventOfType(networkMonitor, NetworkMessageType.CONNECTION_UPDATE, 200);

      assert.ok('rxPackets' in updateEvent);
      assert.ok('rxBytes' in updateEvent);
      assert.ok('txPackets' in updateEvent);
      assert.ok('txBytes' in updateEvent);
      assert.ok('connectionSerial' in updateEvent);
      assert.ok('time' in updateEvent);
    });
  });
});
