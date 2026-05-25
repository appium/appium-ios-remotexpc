import { getLogger } from './lib/logger.js';
import type { RemoteXpcConnection } from './lib/remote-xpc/remote-xpc-connection.js';
import { TunnelManager, rsdSessionLockKey } from './lib/tunnel/index.js';
import type { TunnelEndpoint } from './lib/tunnel/tunnel-api-client.js';
import { getTunnelForDevice } from './lib/tunnel/tunnel-availability.js';
import type {
  DVTInstruments,
  SyslogService as SyslogServiceType,
  XCTestServices,
} from './lib/types.js';
import AfcService from './services/ios/afc/index.js';
import { type Service } from './services/ios/base-service.js';
import { CrashReportsService } from './services/ios/crash-reports/index.js';
import DiagnosticsService from './services/ios/diagnostic-service/index.js';
import { DVTSecureSocketProxyService } from './services/ios/dvt/index.js';
import { ApplicationListing } from './services/ios/dvt/instruments/application-listing.js';
import { ConditionInducer } from './services/ios/dvt/instruments/condition-inducer.js';
import { DeviceInfo } from './services/ios/dvt/instruments/device-info.js';
import { Graphics } from './services/ios/dvt/instruments/graphics.js';
import { LocationSimulation } from './services/ios/dvt/instruments/location-simulation.js';
import { NetworkMonitor } from './services/ios/dvt/instruments/network-monitor.js';
import { Notifications } from './services/ios/dvt/instruments/notifications.js';
import { ProcessControl } from './services/ios/dvt/instruments/process-control.js';
import { Screenshot } from './services/ios/dvt/instruments/screenshot.js';
import { HouseArrestService } from './services/ios/house-arrest/index.js';
import { InstallationProxyService } from './services/ios/installation-proxy/index.js';
import { MisagentService } from './services/ios/misagent/index.js';
import { MobileConfigService } from './services/ios/mobile-config/index.js';
import MobileImageMounterService from './services/ios/mobile-image-mounter/index.js';
import { NotificationProxyService } from './services/ios/notification-proxy/index.js';
import { PowerAssertionService } from './services/ios/power-assertion/index.js';
import { SpringBoardService } from './services/ios/springboard-service/index.js';
import SyslogService from './services/ios/syslog-service/index.js';
import { DvtTestmanagedProxyService } from './services/ios/testmanagerd/index.js';
import { WebInspectorService } from './services/ios/webinspector/index.js';

const log = getLogger('Services');

/** Pause after closing discovery RSD so device `remoted` can accept the next session. */
const RSD_RELEASE_DELAY_MS = 300;

export {
  getAvailableDevices,
  getTunnelForDevice,
} from './lib/tunnel/tunnel-availability.js';

/**
 * Start the diagnostics service for the given device UDID.
 */
export async function startDiagnosticsService(
  udid: string,
): Promise<DiagnosticsService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      DiagnosticsService.RSD_SERVICE_NAME,
    );
    return new DiagnosticsService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the notification proxy service for the given device UDID.
 */
export async function startNotificationProxyService(
  udid: string,
): Promise<NotificationProxyService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      NotificationProxyService.RSD_SERVICE_NAME,
    );
    return new NotificationProxyService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the mobile configuration service for the given device UDID.
 */
export async function startMobileConfigService(
  udid: string,
): Promise<MobileConfigService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      MobileConfigService.RSD_SERVICE_NAME,
    );
    return new MobileConfigService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the mobile image mounter service for the given device UDID.
 */
export async function startMobileImageMounterService(
  udid: string,
): Promise<MobileImageMounterService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      MobileImageMounterService.RSD_SERVICE_NAME,
    );
    return new MobileImageMounterService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the SpringBoard service for the given device UDID.
 */
export async function startSpringboardService(
  udid: string,
): Promise<SpringBoardService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      SpringBoardService.RSD_SERVICE_NAME,
    );
    return new SpringBoardService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the misagent service for the given device UDID.
 */
export async function startMisagentService(
  udid: string,
): Promise<MisagentService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(MisagentService.RSD_SERVICE_NAME);
    return new MisagentService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the power assertion service for the given device UDID.
 */
export async function startPowerAssertionService(
  udid: string,
): Promise<PowerAssertionService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      PowerAssertionService.RSD_SERVICE_NAME,
    );
    return new PowerAssertionService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the syslog service for the given device UDID.
 */
export async function startSyslogService(
  udid: string,
): Promise<SyslogServiceType> {
  return withRemoteXpcConnection(
    udid,
    (_, tunnelConnection) =>
      new SyslogService([tunnelConnection.host, tunnelConnection.port]),
  );
}

const RSD_SYSLOG_BINARY_SERVICE_NAME = 'com.apple.os_trace_relay.shim.remote';
const RSD_SYSLOG_TEXT_SERVICE_NAME = 'com.apple.syslog_relay.shim.remote';

/** Options for {@link startXCTestServices}. */
export interface StartXCTestServicesOptions {
  /** Also resolve and return an InstallationProxyService for app lookup. */
  includeInstallationProxy?: boolean;
}

/**
 * Resolve the syslog binary service (os_trace_relay RemoteXPC shim).
 * Returns an unstarted SyslogService and its service descriptor using a single
 * RemoteXPC connection. Call syslogService.start(serviceDescriptor, packetSource, { pid }).
 */
export async function startSyslogBinaryService(
  udid: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  return startSyslogWithServiceName(udid, RSD_SYSLOG_BINARY_SERVICE_NAME);
}

/**
 * Resolve the syslog text-relay service (iOS 18+ RemoteXPC shim).
 * Returns an unstarted SyslogService and its service descriptor using a single
 * RemoteXPC connection. Call syslogService.start(serviceDescriptor, ..., { textMode: true }).
 */
export async function startSyslogTextService(
  udid: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  return startSyslogWithServiceName(udid, RSD_SYSLOG_TEXT_SERVICE_NAME);
}

/**
 * Start AFC service over RemoteXPC shim.
 * Resolves the AFC service port via RemoteXPC and returns a ready-to-use AfcService instance.
 */
export async function startAfcService(udid: string): Promise<AfcService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const afcDescriptor = remoteXPC.findService(AfcService.RSD_SERVICE_NAME);
    return new AfcService([
      tunnelConnection.host,
      parseInt(afcDescriptor.port, 10),
    ]);
  });
}

/**
 * Start CrashReportsService over RemoteXPC shim.
 * Resolves the crash report copy mobile and crash mover service ports via RemoteXPC.
 */
export async function startCrashReportsService(
  udid: string,
): Promise<CrashReportsService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const copyMobileDescriptor = remoteXPC.findService(
      CrashReportsService.RSD_COPY_MOBILE_NAME,
    );
    const crashMoverDescriptor = remoteXPC.findService(
      CrashReportsService.RSD_CRASH_MOVER_NAME,
    );
    return new CrashReportsService(
      [tunnelConnection.host, parseInt(copyMobileDescriptor.port, 10)],
      [tunnelConnection.host, parseInt(crashMoverDescriptor.port, 10)],
    );
  });
}

/**
 * Start the house arrest service for the given device UDID.
 */
export async function startHouseArrestService(
  udid: string,
): Promise<HouseArrestService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      HouseArrestService.RSD_SERVICE_NAME,
    );
    return new HouseArrestService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the installation proxy service for the given device UDID.
 */
export async function startInstallationProxyService(
  udid: string,
): Promise<InstallationProxyService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      InstallationProxyService.RSD_SERVICE_NAME,
    );
    return new InstallationProxyService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the web inspector service for the given device UDID.
 */
export async function startWebInspectorService(
  udid: string,
): Promise<WebInspectorService> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
    const descriptor = remoteXPC.findService(
      WebInspectorService.RSD_SERVICE_NAME,
    );
    return new WebInspectorService([
      tunnelConnection.host,
      parseInt(descriptor.port, 10),
    ]);
  });
}

/**
 * Start the DVT secure socket proxy service and instrument clients.
 */
export async function startDVTService(udid: string): Promise<DVTInstruments> {
  const { host, port } = await withRemoteXpcConnection(
    udid,
    (remoteXPC, tunnelConnection) => {
      const dvtServiceDescriptor = remoteXPC.findService(
        DVTSecureSocketProxyService.RSD_SERVICE_NAME,
      );
      return {
        host: tunnelConnection.host,
        port: parseInt(dvtServiceDescriptor.port, 10),
      };
    },
  );

  const dvtService = new DVTSecureSocketProxyService([host, port]);
  await dvtService.connect();

  return {
    dvtService,
    locationSimulation: new LocationSimulation(dvtService),
    conditionInducer: new ConditionInducer(dvtService),
    screenshot: new Screenshot(dvtService),
    appListing: new ApplicationListing(dvtService),
    graphics: new Graphics(dvtService),
    deviceInfo: new DeviceInfo(dvtService),
    notification: new Notifications(dvtService),
    networkMonitor: new NetworkMonitor(dvtService),
    processControl: new ProcessControl(dvtService),
  };
}

/**
 * Start the testmanagerd service for the given device UDID.
 */
export async function startTestmanagerdService(
  udid: string,
): Promise<DvtTestmanagedProxyService> {
  const { host, port } = await withRemoteXpcConnection(
    udid,
    (remoteXPC, tunnelConnection) => {
      const testmanagerdDescriptor = remoteXPC.findService(
        DvtTestmanagedProxyService.RSD_SERVICE_NAME,
      );
      return {
        host: tunnelConnection.host,
        port: parseInt(testmanagerdDescriptor.port, 10),
      };
    },
  );

  const testmanagerdService = new DvtTestmanagedProxyService([host, port]);
  await testmanagerdService.connect();
  return testmanagerdService;
}

/**
 * Start all services needed for an XCTest session using a single RemoteXPC
 * connection for service discovery. This avoids ECONNRESET errors caused by
 * opening multiple RemoteXPC connections simultaneously through the tunnel.
 *
 * The RemoteXPC connection is closed internally after port discovery.
 * Callers are responsible for closing execTestmanagerd, controlTestmanagerd,
 * and dvtService when done.
 */
export async function startXCTestServices(
  udid: string,
  options?: StartXCTestServicesOptions,
): Promise<XCTestServices> {
  const { testmanagerdPort, dvtPort, installationProxyPort, host } =
    await withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => {
      const testmanagerd = parseInt(
        remoteXPC.findService(DvtTestmanagedProxyService.RSD_SERVICE_NAME).port,
        10,
      );
      const dvt = parseInt(
        remoteXPC.findService(DVTSecureSocketProxyService.RSD_SERVICE_NAME)
          .port,
        10,
      );
      const installationProxy = options?.includeInstallationProxy
        ? parseInt(
            remoteXPC.findService(InstallationProxyService.RSD_SERVICE_NAME)
              .port,
            10,
          )
        : undefined;
      return {
        host: tunnelConnection.host,
        testmanagerdPort: testmanagerd,
        dvtPort: dvt,
        installationProxyPort: installationProxy,
      };
    });

  // Create individual service connections with cleanup on partial failure
  let execTestmanagerd: DvtTestmanagedProxyService | null = null;
  let controlTestmanagerd: DvtTestmanagedProxyService | null = null;
  let dvtService: DVTSecureSocketProxyService | null = null;
  let installationProxy: InstallationProxyService | undefined;
  try {
    execTestmanagerd = new DvtTestmanagedProxyService([host, testmanagerdPort]);
    await execTestmanagerd.connect();

    controlTestmanagerd = new DvtTestmanagedProxyService([
      host,
      testmanagerdPort,
    ]);
    await controlTestmanagerd.connect();

    dvtService = new DVTSecureSocketProxyService([host, dvtPort]);
    await dvtService.connect();

    if (installationProxyPort !== undefined) {
      installationProxy = new InstallationProxyService([
        host,
        installationProxyPort,
      ]);
    }
  } catch (err) {
    installationProxy?.close();
    await dvtService?.close().catch(() => {});
    await controlTestmanagerd?.close().catch(() => {});
    await execTestmanagerd?.close().catch(() => {});
    throw err;
  }

  const processControl = new ProcessControl(dvtService);

  return {
    execTestmanagerd,
    controlTestmanagerd,
    dvtService,
    processControl,
    installationProxy,
  };
}

/**
 * Run `fn` with a freshly opened discovery `RemoteXpcConnection` and close
 * that connection unconditionally when `fn` settles. Use this whenever a
 * `start*Service` helper only needs the RSD to discover a service port:
 * the discovery RSD is single-use, so leaking it would race with `remoted`.
 */
export async function withRemoteXpcConnection<T>(
  udid: string,
  fn: (
    remoteXPC: RemoteXpcConnection,
    tunnelConnection: TunnelEndpoint,
  ) => T | Promise<T>,
): Promise<T> {
  const tunnelConnection = await getTunnelForDevice(udid);
  const lockKey = rsdSessionLockKey(
    tunnelConnection.host,
    tunnelConnection.port,
  );

  return TunnelManager.runSerializedRsdSession(lockKey, async () => {
    const remoteXPC = await TunnelManager.connectRemoteXPCUnlocked(
      tunnelConnection.host,
      tunnelConnection.port,
    );
    let fnError: unknown;
    let result: T | undefined;
    try {
      result = await fn(remoteXPC, tunnelConnection);
    } catch (err) {
      fnError = err;
    } finally {
      try {
        await remoteXPC.close();
      } catch (err) {
        log.warn(
          `Discovery RemoteXpcConnection close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (RSD_RELEASE_DELAY_MS > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RSD_RELEASE_DELAY_MS),
        );
      }
    }
    if (fnError !== undefined) {
      throw fnError;
    }
    return result as T;
  });
}

/**
 * Resolve syslog service descriptor by RemoteXPC service name.
 */
async function startSyslogWithServiceName(
  udid: string,
  serviceName: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  return withRemoteXpcConnection(udid, (remoteXPC, tunnelConnection) => ({
    syslogService: new SyslogService([
      tunnelConnection.host,
      tunnelConnection.port,
    ]),
    serviceDescriptor: remoteXPC.findService(serviceName),
  }));
}
