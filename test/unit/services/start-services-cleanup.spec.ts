import { expect } from 'chai';
import esmock from 'esmock';
import * as sinon from 'sinon';

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
 * Load `src/services.ts` with `TunnelManager.connectRemoteXPCUnlocked`,
 * the strongbox registry port, and the tunnel API client all stubbed so
 * we can exercise the `withRemoteXpcConnection` cleanup contract without
 * a real device.
 */
async function loadServicesWithStubs(
  options: { findServiceImpl?: (name: string) => unknown } = {},
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
          return { host: '127.0.0.1', port: 1234 };
        }
      },
    },
    '../../../src/lib/tunnel/index.js': {
      TunnelManager: {
        rsdSessionLockKey: (host: string, port: number) => `${host}:${port}`,
        runSerializedRsdSession: async (
          _lockKey: string,
          fn: () => Promise<unknown>,
        ) => fn(),
        connectRemoteXPCUnlocked: async () => remoteXPCStub,
      },
    },
  });

  return { services, remoteXPCStub, closeSpy, findServiceStub };
}

describe('start*Service — discovery RemoteXpcConnection lifecycle', function () {
  describe('withRemoteXpcConnection contract (via startAfcService)', function () {
    it('closes the discovery connection after the helper returns', async function () {
      const { services, closeSpy, findServiceStub } =
        await loadServicesWithStubs();

      await services.startAfcService('test-udid');

      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call, got ${closeSpy.callCount}`,
      ).to.equal(true);
      sinon.assert.callOrder(findServiceStub, closeSpy);
    });

    it('closes the discovery connection even when the body throws', async function () {
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

      expect(caught, 'expected the error to propagate').to.exist;
      expect(
        closeSpy.calledOnce,
        `expected exactly one close() call on the error path, got ${closeSpy.callCount}`,
      ).to.equal(true);
    });
  });

  describe('RSD service-name correctness', function () {
    it('startAfcService queries the AFC RSD shim by name', async function () {
      const { services, findServiceStub } = await loadServicesWithStubs();

      await services.startAfcService('test-udid');

      expect(
        findServiceStub.calledOnceWith('com.apple.afc.shim.remote'),
        'expected findService("com.apple.afc.shim.remote")',
      ).to.equal(true);
    });

    it('startSyslogBinaryService queries the os_trace_relay RSD shim by name', async function () {
      const { services, findServiceStub } = await loadServicesWithStubs();

      await services.startSyslogBinaryService('test-udid');

      expect(
        findServiceStub.calledOnceWith('com.apple.os_trace_relay.shim.remote'),
        'expected findService("com.apple.os_trace_relay.shim.remote")',
      ).to.equal(true);
    });
  });

  describe('withRemoteXpcConnection contract (other start*Service helpers)', function () {
    for (const fn of [
      'startInstallationProxyService',
      'startNotificationProxyService',
      'startCrashReportsService',
    ] as const) {
      it(`${fn} closes the discovery connection after returning`, async function () {
        const { services, closeSpy } = await loadServicesWithStubs();
        await services[fn]('test-udid');
        expect(
          closeSpy.calledOnce,
          `expected exactly one close() for ${fn}, got ${closeSpy.callCount}`,
        ).to.equal(true);
      });
    }

    it('startCrashReportsService resolves both crash report shims in one discovery pass', async function () {
      const { services, findServiceStub } = await loadServicesWithStubs();
      await services.startCrashReportsService('test-udid');
      expect(findServiceStub.callCount).to.equal(2);
      sinon.assert.calledWith(
        findServiceStub.firstCall,
        'com.apple.crashreportcopymobile.shim.remote',
      );
      sinon.assert.calledWith(
        findServiceStub.secondCall,
        'com.apple.crashreportmover.shim.remote',
      );
    });
  });
});
