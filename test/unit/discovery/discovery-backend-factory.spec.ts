import { expect } from 'chai';

import { BonjourDiscoveryBackend } from '../../../src/lib/discovery/bonjour-discovery-backend.js';
import { createDiscoveryBackend } from '../../../src/lib/discovery/discovery-backend-factory.js';
import { DnssdDiscoveryBackend } from '../../../src/lib/discovery/dnssd-discovery-backend.js';

describe('createDiscoveryBackend', function () {
  const options = { serviceType: '_test._tcp', domain: 'local' };

  it('returns BonjourDiscoveryBackend on darwin', function () {
    const backend = createDiscoveryBackend('darwin', options);
    expect(backend).to.be.instanceOf(BonjourDiscoveryBackend);
  });

  it('returns DnssdDiscoveryBackend on linux', function () {
    const backend = createDiscoveryBackend('linux', options);
    expect(backend).to.be.instanceOf(DnssdDiscoveryBackend);
  });

  it('returns DnssdDiscoveryBackend on win32', function () {
    const backend = createDiscoveryBackend('win32', options);
    expect(backend).to.be.instanceOf(DnssdDiscoveryBackend);
  });

  it('forwards options to the chosen backend', function () {
    const opts = { serviceType: '_foo._tcp', domain: 'example' };
    const darwin = createDiscoveryBackend('darwin', opts) as unknown as {
      options: typeof opts;
    };
    const linux = createDiscoveryBackend('linux', opts) as unknown as {
      options: typeof opts;
    };
    expect(darwin.options).to.deep.equal(opts);
    expect(linux.options).to.deep.equal(opts);
  });

  it('uses sensible defaults when options are omitted', function () {
    const backend = createDiscoveryBackend('darwin') as unknown as {
      options: { serviceType: string; domain: string };
    };
    expect(backend.options).to.have.property('serviceType').that.is.a('string');
    expect(backend.options).to.have.property('domain').that.is.a('string');
  });
});
