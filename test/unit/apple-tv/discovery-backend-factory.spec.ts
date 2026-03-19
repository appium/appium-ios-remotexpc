import { expect } from 'chai';

import { createDiscoveryBackend } from '../../../src/lib/discovery/discovery-backend-factory.js';
import { DnssdDiscoveryBackend } from '../../../src/lib/discovery/dnssd-discovery-backend.js';

describe('Discovery backend factory', function () {
  it('returns dnssd backend on darwin', function () {
    const backend = createDiscoveryBackend('darwin');
    expect(backend).to.be.instanceOf(DnssdDiscoveryBackend);
  });

  it('returns dnssd backend on non-darwin', function () {
    const backend = createDiscoveryBackend('linux');
    expect(backend).to.be.instanceOf(DnssdDiscoveryBackend);
  });
});
