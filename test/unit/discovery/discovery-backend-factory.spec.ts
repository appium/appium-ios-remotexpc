import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createDiscoveryBackend} from '../../../src/lib/discovery/discovery-backend-factory.js';
import {MdnsDiscoveryBackend} from '../../../src/lib/discovery/mdns-discovery-backend.js';

describe('createDiscoveryBackend', function () {
  const options = {serviceType: '_test._tcp', domain: 'local'};

  it('returns MdnsDiscoveryBackend on darwin', function () {
    const backend = createDiscoveryBackend('darwin', options);
    assert.ok(backend instanceof MdnsDiscoveryBackend);
  });

  it('returns MdnsDiscoveryBackend on linux', function () {
    const backend = createDiscoveryBackend('linux', options);
    assert.ok(backend instanceof MdnsDiscoveryBackend);
  });

  it('returns MdnsDiscoveryBackend on win32', function () {
    const backend = createDiscoveryBackend('win32', options);
    assert.ok(backend instanceof MdnsDiscoveryBackend);
  });

  it('forwards options to the backend', function () {
    const opts = {serviceType: '_foo._tcp', domain: 'example'};
    const backend = createDiscoveryBackend('linux', opts) as unknown as {
      options: typeof opts;
    };
    assert.deepStrictEqual(backend.options, opts);
  });

  it('uses sensible defaults when options are omitted', function () {
    const backend = createDiscoveryBackend('linux') as unknown as {
      options: {serviceType: string; domain: string};
    };
    assert.ok(typeof backend.options.serviceType === 'string');
    assert.ok(typeof backend.options.domain === 'string');
  });
});
