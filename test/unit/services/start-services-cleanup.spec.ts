import { expect } from 'chai';
import esmock from 'esmock';
import sinon from 'sinon';

interface RemoteXpcStub {
  findService: sinon.SinonStub;
  close: sinon.SinonSpy;
}

interface LoadedServices {
  services: Record<string, any>;
  remoteXPCStub: RemoteXpcStub;
  closeSpy: sinon.SinonSpy;
  findServiceStub: sinon.SinonStub;
}

/**
 * Load `src/services.ts` with `TunnelManager.createRemoteXPCConnection`,
 * the strongbox registry port, and the tunnel API client all stubbed.
 *
 * The returned `closeSpy` lets each test assert that the internally-created
 * `RemoteXpcConnection` was closed after port discovery, mirroring the
 * `try/finally { remoteXPC.close() }` pattern the file already uses inside
 * `startXCTestServices`.
 */
async function loadServicesWithStubs(
  options: {
    findServiceImpl?: (name: string) => unknown;
  } = {},
): Promise<LoadedServices> {
  const closeSpy = sinon.spy(async () => {});
  const findServiceStub = sinon.stub();
  if (options.findServiceImpl) {
    findServiceStub.callsFake(options.findServiceImpl);
  } else {
    findServiceStub.callsFake((serviceName: string) => ({
      serviceName,
      port: '49374',
    }));
  }

  const remoteXPCStub: RemoteXpcStub = {
    findService: findServiceStub,
    close: closeSpy,
  };

  const tunnelConnection = { host: '127.0.0.1', port: 1234 };

  const services = await esmock('../../../src/services.js', {
    '@appium/strongbox': {
      strongbox: () => ({}),
      BaseItem: class {
        async read() {
          return '12345';
        }
      },
    },
    '../../../src/lib/tunnel/tunnel-api-client.js': {
      TunnelApiClient: class {
        async hasTunnel() {
          return true;
        }
        async getTunnelConnection() {
          return tunnelConnection;
        }
      },
    },
    '../../../src/lib/tunnel/index.js': {
      TunnelManager: {
        createRemoteXPCConnection: async () => remoteXPCStub,
      },
    },
  });

  return { services, remoteXPCStub, closeSpy, findServiceStub };
}

describe('start*Service — internal RemoteXpcConnection cleanup', function () {
  describe('startAfcService', function () {
    it('closes the internal remoteXPC after port discovery', async function () {
      const { services, closeSpy, findServiceStub } =
        await loadServicesWithStubs();

      await services.startAfcService('test-udid');

      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call, got ${closeSpy.callCount}`,
      ).to.equal(true);
      expect(
        findServiceStub.calledWith('com.apple.afc.shim.remote'),
        'expected findService to be queried for the AFC RSD shim name',
      ).to.equal(true);
      sinon.assert.callOrder(findServiceStub, closeSpy);
    });

    it('still closes remoteXPC when findService throws (try/finally semantics)', async function () {
      const { services, closeSpy } = await loadServicesWithStubs({
        findServiceImpl: () => {
          throw new Error('Service not found');
        },
      });

      let caught: Error | undefined;
      try {
        await services.startAfcService('test-udid');
      } catch (err) {
        caught = err as Error;
      }

      expect(caught, 'expected findService error to propagate').to.exist;
      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call even on error path, got ${closeSpy.callCount}`,
      ).to.equal(true);
    });
  });

  describe('startSyslogService', function () {
    /**
     * Special case: this helper does not call `findService` at all — it
     * historically created a `RemoteXpcConnection` and dropped the
     * reference on the floor. The fix wraps the unused connection in
     * `try/finally` so it is always closed.
     */
    it('closes the internal remoteXPC even though it never calls findService', async function () {
      const { services, closeSpy, findServiceStub } =
        await loadServicesWithStubs();

      await services.startSyslogService('test-udid');

      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call, got ${closeSpy.callCount}`,
      ).to.equal(true);
      expect(
        findServiceStub.called,
        'helper must not consult findService',
      ).to.equal(false);
    });
  });

  describe('startSyslog{Binary,Text}Service', function () {
    /**
     * Both wrappers delegate to the private `startSyslogWithServiceName`
     * helper with different RSD service names; one parameterized test
     * covers both surfaces without duplicated assertion code.
     */
    const cases: { fn: string; expectedRsdName: string }[] = [
      {
        fn: 'startSyslogBinaryService',
        expectedRsdName: 'com.apple.os_trace_relay.shim.remote',
      },
      {
        fn: 'startSyslogTextService',
        expectedRsdName: 'com.apple.syslog_relay.shim.remote',
      },
    ];

    for (const { fn, expectedRsdName } of cases) {
      it(`${fn} closes the internal remoteXPC after port discovery`, async function () {
        const { services, closeSpy, findServiceStub } =
          await loadServicesWithStubs();

        await services[fn]('test-udid');

        expect(
          closeSpy.calledOnce,
          `${fn}: expected exactly one close() call, got ${closeSpy.callCount}`,
        ).to.equal(true);
        expect(
          findServiceStub.calledWith(expectedRsdName),
          `${fn}: expected findService to be queried for ${expectedRsdName}`,
        ).to.equal(true);
        sinon.assert.callOrder(findServiceStub, closeSpy);
      });
    }

    it('startSyslogBinaryService still closes remoteXPC when findService throws (try/finally semantics)', async function () {
      const { services, closeSpy } = await loadServicesWithStubs({
        findServiceImpl: () => {
          throw new Error('Service not found');
        },
      });

      let caught: Error | undefined;
      try {
        await services.startSyslogBinaryService('test-udid');
      } catch (err) {
        caught = err as Error;
      }

      expect(caught, 'expected findService error to propagate').to.exist;
      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call even on error path, got ${closeSpy.callCount}`,
      ).to.equal(true);
    });
  });
});
