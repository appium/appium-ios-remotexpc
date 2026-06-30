import {describe, it} from 'node:test';

import {expect} from 'chai';

import {createDiscoveryBackend} from '../../../src/lib/discovery/discovery-backend-factory.js';
import {MdnsDiscoveryBackend} from '../../../src/lib/discovery/mdns-discovery-backend.js';

describe('createDiscoveryBackend', function () {
  const options = {serviceType: '_test._tcp', domain: 'local'};

  it('returns MdnsDiscoveryBackend on darwin', function () {
    const backend = createDiscoveryBackend('darwin', options);
    expect(backend).to.be.instanceOf(MdnsDiscoveryBackend);
  });

  it('returns MdnsDiscoveryBackend on linux', function () {
    const backend = createDiscoveryBackend('linux', options);
    expect(backend).to.be.instanceOf(MdnsDiscoveryBackend);
  });

  it('returns MdnsDiscoveryBackend on win32', function () {
    const backend = createDiscoveryBackend('win32', options);
    expect(backend).to.be.instanceOf(MdnsDiscoveryBackend);
  });

  it('forwards options to the backend', function () {
    const opts = {serviceType: '_foo._tcp', domain: 'example'};
    const backend = createDiscoveryBackend('linux', opts) as unknown as {
      options: typeof opts;
    };
    expect(backend.options).to.deep.equal(opts);
  });

  it('uses sensible defaults when options are omitted', function () {
    const backend = createDiscoveryBackend('linux') as unknown as {
      options: {serviceType: string; domain: string};
    };
    expect(backend.options).to.have.property('serviceType').that.is.a('string');
    expect(backend.options).to.have.property('domain').that.is.a('string');
  });
});
