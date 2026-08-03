import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import * as sinon from 'sinon';

import {mockImport} from '../../helpers/mock-module.js';

describe('tunnel-rsd-discovery', function () {
  it('discovers services and always closes the RSD connection', async function (t) {
    const closeSpy = sinon.spy(async () => {});
    const getServices = sinon.stub().returns([{serviceName: 'com.apple.test', port: '1234'}]);
    const connect = sinon.spy(async () => {});

    const {discoverServices, servicesToCatalog} = await mockImport(
      t,
      '../../../src/lib/tunnel/tunnel-rsd-discovery.js',
      import.meta.url,
      {
        '../../../src/lib/remote-xpc/rsd-service-catalog-client.js': {
          RsdServiceCatalogClient: class {
            connect = connect;
            getServices = getServices;
            close = closeSpy;
          },
        },
      },
    );

    const services = await discoverServices('udid-1', 'fd00::1', 99_999);
    assert.strictEqual(services.length, 1);
    assert.strictEqual(connect.calledOnce, true);
    assert.strictEqual(closeSpy.calledOnce, true);

    const catalog = servicesToCatalog(services);
    assert.strictEqual(catalog['com.apple.test']?.port, '1234');
  });

  it('singleflight coalesces parallel discover for the same UDID', async function (t) {
    let connectCount = 0;
    const closeSpy = sinon.spy(async () => {});

    const {discoverServices} = await mockImport(t, '../../../src/lib/tunnel/tunnel-rsd-discovery.js', import.meta.url, {
      '../../../src/lib/remote-xpc/rsd-service-catalog-client.js': {
        RsdServiceCatalogClient: class {
          async connect() {
            connectCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          getServices() {
            return [{serviceName: 'com.apple.test', port: '1'}];
          }
          close = closeSpy;
        },
      },
    });

    const [a, b] = await Promise.all([
      discoverServices('udid-2', 'fd00::2', 88_888),
      discoverServices('udid-2', 'fd00::2', 88_888),
    ]);

    assert.strictEqual(connectCount, 1);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(closeSpy.calledOnce, true);
  });
});
