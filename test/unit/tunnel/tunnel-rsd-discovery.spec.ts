import { expect } from 'chai';
import esmock from 'esmock';
import * as sinon from 'sinon';

describe('tunnel-rsd-discovery', function () {
  it('discovers services and always closes the RSD connection', async function () {
    const closeSpy = sinon.spy(async () => {});
    const getServices = sinon
      .stub()
      .returns([{ serviceName: 'com.apple.test', port: '1234' }]);
    const connect = sinon.spy(async () => {});

    const { discoverServices, servicesToCatalog } = await esmock(
      '../../../src/lib/tunnel/tunnel-rsd-discovery.js',
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
    expect(services).to.have.length(1);
    expect(connect.calledOnce).to.equal(true);
    expect(closeSpy.calledOnce).to.equal(true);

    const catalog = servicesToCatalog(services);
    expect(catalog['com.apple.test']?.port).to.equal('1234');
  });

  it('singleflight coalesces parallel discover for the same UDID', async function () {
    let connectCount = 0;
    const closeSpy = sinon.spy(async () => {});

    const { discoverServices } = await esmock(
      '../../../src/lib/tunnel/tunnel-rsd-discovery.js',
      {
        '../../../src/lib/remote-xpc/rsd-service-catalog-client.js': {
          RsdServiceCatalogClient: class {
            async connect() {
              connectCount += 1;
              await new Promise((resolve) => setTimeout(resolve, 30));
            }
            getServices() {
              return [{ serviceName: 'com.apple.test', port: '1' }];
            }
            close = closeSpy;
          },
        },
      },
    );

    const [a, b] = await Promise.all([
      discoverServices('udid-2', 'fd00::2', 88_888),
      discoverServices('udid-2', 'fd00::2', 88_888),
    ]);

    expect(connectCount).to.equal(1);
    expect(a).to.deep.equal(b);
    expect(closeSpy.calledOnce).to.equal(true);
  });
});
