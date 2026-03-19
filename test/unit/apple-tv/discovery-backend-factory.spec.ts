import { expect } from 'chai';

import { DevicectlDiscoveryBackend } from '../../../src/lib/discovery/devicectl-discovery-backend.js';
import { createDiscoveryBackend } from '../../../src/lib/discovery/discovery-backend-factory.js';
import { DnssdDiscoveryBackend } from '../../../src/lib/discovery/dnssd-discovery-backend.js';

describe('Discovery backend factory', function () {
  it('returns devicectl backend on darwin', function () {
    const backend = createDiscoveryBackend('darwin');
    expect(backend).to.be.instanceOf(DevicectlDiscoveryBackend);
  });

  it('returns dnssd backend on non-darwin', function () {
    const backend = createDiscoveryBackend('linux');
    expect(backend).to.be.instanceOf(DnssdDiscoveryBackend);
  });
});
