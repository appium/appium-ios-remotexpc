import { expect } from 'chai';

import { BonjourDiscovery } from '../../../src/lib/bonjour/bonjour-discovery.js';

/**
 * Promise-based event waiter that:
 * - Resolves on the first matching event
 * - Rejects after `ms` milliseconds
 * - Cleans up the listener on both resolve and reject
 */
function waitForEvent<T>(
  emitter: {
    on: (event: string, cb: (arg: T) => void) => unknown;
    off: (event: string, cb: (arg: T) => void) => unknown;
  },
  event: string,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onEvent = (data: T) => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolve(data);
    };
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, ms);
    emitter.on(event, onEvent);
  });
}

describe('BonjourDiscovery', function () {
  let discovery: BonjourDiscovery;

  beforeEach(function () {
    discovery = new BonjourDiscovery();
  });

  afterEach(function () {
    discovery.stopBrowsing();
  });

  describe('processBrowseOutput', function () {
    it('should add discovered services', async function () {
      this.timeout(5000); // keep mocha timeout higher than internal timeout
      const mockOutput = `
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;

      // Start waiting before triggering to avoid race conditions
      const servicePromise = waitForEvent<any>(
        discovery as any,
        'serviceAdded',
        2000,
      );

      discovery.processBrowseOutput(mockOutput);

      const service = await servicePromise;
      expect(service.name).to.equal('Living Room');
      expect(service.type).to.equal('_remotepairing-manual-pairing._tcp.');
      expect(service.domain).to.equal('local.');
      expect(service.interfaceIndex).to.equal(4);
    });

    it('should remove services', async function () {
      this.timeout(5000); // keep mocha timeout higher than internal timeout

      const addOutput = `
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;
      const removeOutput = `
12:34:57.789  Rmv        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;

      // Add first, synchronously
      discovery.processBrowseOutput(addOutput);
      expect(discovery.getDiscoveredServices()).to.have.lengthOf(1);

      // Begin waiting for removal before triggering it
      const removedNamePromise = waitForEvent<string>(
        discovery as any,
        'serviceRemoved',
        2000,
      );

      discovery.processBrowseOutput(removeOutput);

      const removedName = await removedNamePromise;
      expect(removedName).to.equal('Living Room');
      expect(discovery.getDiscoveredServices()).to.have.lengthOf(0);
    });

    it('should handle multiple services in one output', function () {
      const mockOutput = `
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
12:34:56.790  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Bedroom
12:34:56.791  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Kitchen
`;

      (discovery as any).processBrowseOutput(mockOutput);

      const services = discovery.getDiscoveredServices();
      expect(services).to.have.lengthOf(3);
      expect(services.map((s: any) => s.name)).to.include.members([
        'Living Room',
        'Bedroom',
        'Kitchen',
      ]);
    });
  });

  describe('getDiscoveredServices', function () {
    it('should return empty array when no services discovered', function () {
      expect(discovery.getDiscoveredServices()).to.deep.equal([]);
    });

    it('should return all discovered services', function () {
      const mockOutput = `
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Device1
12:34:56.790  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Device2
`;

      (discovery as any).processBrowseOutput(mockOutput);

      const services = discovery.getDiscoveredServices();
      expect(services).to.have.lengthOf(2);
      expect(services.map((s: any) => s.name)).to.include.members([
        'Device1',
        'Device2',
      ]);
    });
  });
});
