import { expect } from 'chai';

import { BonjourDiscovery } from '../../../src/lib/bonjour/bonjour-discovery.js';

describe('BonjourDiscovery', function () {
  let discovery: BonjourDiscovery;

  beforeEach(function () {
    discovery = new BonjourDiscovery();
  });

  afterEach(function () {
    discovery.stopBrowsing();
  });

  describe('processBrowseOutput', function () {
    it('should add discovered services', function (done) {
      const mockOutput = `
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;

      discovery.on('serviceAdded', (service) => {
        expect(service.name).to.equal('Living Room');
        expect(service.type).to.equal('_remotepairing-manual-pairing._tcp.');
        expect(service.domain).to.equal('local.');
        expect(service.interfaceIndex).to.equal(4);
        done();
      });

      discovery.processBrowseOutput(mockOutput);
    });

    it('should remove services', function (done) {
      const addOutput = `
12:34:56.789  Add        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;
      const removeOutput = `
12:34:57.789  Rmv        3  4 local.               _remotepairing-manual-pairing._tcp.  Living Room
`;

      discovery.processBrowseOutput(addOutput);

      discovery.on('serviceRemoved', (serviceName) => {
        expect(serviceName).to.equal('Living Room');
        expect(discovery.getDiscoveredServices()).to.have.lengthOf(0);
        done();
      });

      discovery.processBrowseOutput(removeOutput);
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
      expect(services.map((s) => s.name)).to.include.members([
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
    });
  });
});
