import esmock from 'esmock';
import * as sinon from 'sinon';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 49_374;
const TEST_UDID = 'test-udid';
const WAIT_OPTS = { waitMs: 15_000 };

interface LoadedServices {
  services: Record<string, (...args: unknown[]) => Promise<unknown>>;
  resolveTunnelService: sinon.SinonStub;
  resolveTunnelServicePorts: sinon.SinonStub;
}

async function loadServicesWithStubs(
  options: {
    resolveTunnelServiceImpl?: (
      udid: string,
      serviceName: string,
    ) => Promise<{ host: string; port: number; udid: string }>;
    resolveTunnelServicePortsImpl?: (
      udid: string,
      serviceNames: string[],
    ) => Promise<{
      host: string;
      ports: Record<string, number>;
      udid: string;
    }>;
    getTunnelForDeviceImpl?: () => Promise<{
      host: string;
      port: number;
      udid: string;
    }>;
  } = {},
): Promise<LoadedServices> {
  const resolveTunnelService = sinon.stub();
  if (options.resolveTunnelServiceImpl) {
    resolveTunnelService.callsFake(options.resolveTunnelServiceImpl);
  } else {
    resolveTunnelService.resolves({
      host: TEST_HOST,
      port: TEST_PORT,
      udid: TEST_UDID,
    });
  }

  const resolveTunnelServicePorts = sinon.stub();
  if (options.resolveTunnelServicePortsImpl) {
    resolveTunnelServicePorts.callsFake(options.resolveTunnelServicePortsImpl);
  } else {
    resolveTunnelServicePorts.callsFake(
      async (_udid: string, serviceNames: string[]) => ({
        host: TEST_HOST,
        ports: Object.fromEntries(
          serviceNames.map((name) => [name, TEST_PORT]),
        ),
        udid: TEST_UDID,
      }),
    );
  }

  const services = await esmock('../../../src/services.js', {
    '../../../src/lib/tunnel/tunnel-service-resolver.js': {
      resolveTunnelService,
      resolveTunnelServicePorts,
      DEFAULT_TUNNEL_SERVICE_WAIT_MS: 15_000,
    },
    '../../../src/lib/tunnel/tunnel-availability.js': {
      getTunnelForDevice:
        options.getTunnelForDeviceImpl ??
        (async () => ({
          host: TEST_HOST,
          port: 1234,
          udid: TEST_UDID,
        })),
    },
  });

  return { services, resolveTunnelService, resolveTunnelServicePorts };
}

describe('start*Service — registry catalog resolution', function () {
  describe('resolveTunnelService (via startAfcService)', function () {
    it('resolves the AFC RSD shim by name before creating the instance', async function () {
      const { services, resolveTunnelService } = await loadServicesWithStubs();

      const afc = await services.startAfcService(TEST_UDID);

      expect(afc).to.exist;
      expect(
        resolveTunnelService.calledOnceWith(
          TEST_UDID,
          'com.apple.afc.shim.remote',
          WAIT_OPTS,
        ),
      ).to.equal(true);
    });

    it('propagates resolver errors', async function () {
      const { services } = await loadServicesWithStubs({
        resolveTunnelServiceImpl: async () => {
          throw new Error('catalog missing service');
        },
      });

      let caught: Error | undefined;
      try {
        await services.startAfcService(TEST_UDID);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught?.message).to.equal('catalog missing service');
    });
  });

  describe('RSD service-name correctness', function () {
    it('startSyslogBinaryService queries the os_trace_relay RSD shim by name', async function () {
      const { services, resolveTunnelService } = await loadServicesWithStubs();

      const result = await services.startSyslogBinaryService(TEST_UDID);
      const { serviceDescriptor } = result as {
        serviceDescriptor: { serviceName: string; port: string };
      };

      expect(
        resolveTunnelService.calledOnceWith(
          TEST_UDID,
          'com.apple.os_trace_relay.shim.remote',
          WAIT_OPTS,
        ),
      ).to.equal(true);
      expect(serviceDescriptor).to.deep.equal({
        serviceName: 'com.apple.os_trace_relay.shim.remote',
        port: String(TEST_PORT),
      });
    });
  });

  describe('other start*Service helpers', function () {
    for (const [fn, serviceName] of [
      [
        'startInstallationProxyService',
        'com.apple.mobile.installation_proxy.shim.remote',
      ],
      [
        'startNotificationProxyService',
        'com.apple.mobile.notification_proxy.shim.remote',
      ],
      ['startHidIndigoService', 'com.apple.coredevice.hid.indigo'],
      ['startPasteboardService', 'com.apple.coredevice.pasteboardservice'],
    ] as const) {
      it(`${fn} resolves ${serviceName} from the catalog`, async function () {
        const { services, resolveTunnelService } =
          await loadServicesWithStubs();
        await services[fn](TEST_UDID);
        expect(
          resolveTunnelService.calledOnceWith(
            TEST_UDID,
            serviceName,
            WAIT_OPTS,
          ),
        ).to.equal(true);
      });
    }

    it('startCrashReportsService resolves both crash report shims', async function () {
      const { services, resolveTunnelServicePorts } =
        await loadServicesWithStubs();

      await services.startCrashReportsService(TEST_UDID);

      expect(resolveTunnelServicePorts.callCount).to.equal(1);
      sinon.assert.calledWith(
        resolveTunnelServicePorts.firstCall,
        TEST_UDID,
        [
          'com.apple.crashreportcopymobile.shim.remote',
          'com.apple.crashreportmover.shim.remote',
        ],
        WAIT_OPTS,
      );
    });
  });
});
