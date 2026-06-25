import {
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  resolveTunnelService,
  resolveTunnelServicePorts,
} from './lib/tunnel/tunnel-service-resolver.js';
import type {
  DVTInstruments,
  SyslogService as SyslogServiceType,
  XCTestServices,
} from './lib/types.js';
import AfcService from './services/ios/afc/index.js';
import { AppServiceService } from './services/ios/app-service/index.js';
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
import { Sysmontap } from './services/ios/dvt/instruments/sysmontap.js';
import { HidIndigoService } from './services/ios/hid-indigo/index.js';
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
import ZipConduitService from './services/ios/zipconduit/index.js';

export {
  getAvailableDevices,
  getTunnelForDevice,
} from './lib/tunnel/tunnel-availability.js';

const SERVICE_WAIT_MS = DEFAULT_TUNNEL_SERVICE_WAIT_MS;

/**
 * Start the diagnostics service for the given device UDID.
 */
export async function startDiagnosticsService(
  udid: string,
): Promise<DiagnosticsService> {
  await requireCatalogService(udid, DiagnosticsService.RSD_SERVICE_NAME);
  return new DiagnosticsService(udid);
}

/**
 * Start the notification proxy service for the given device UDID.
 */
export async function startNotificationProxyService(
  udid: string,
): Promise<NotificationProxyService> {
  await requireCatalogService(udid, NotificationProxyService.RSD_SERVICE_NAME);
  return new NotificationProxyService(udid);
}

/**
 * Start the mobile configuration service for the given device UDID.
 */
export async function startMobileConfigService(
  udid: string,
): Promise<MobileConfigService> {
  await requireCatalogService(udid, MobileConfigService.RSD_SERVICE_NAME);
  return new MobileConfigService(udid);
}

/**
 * Start the mobile image mounter service for the given device UDID.
 */
export async function startMobileImageMounterService(
  udid: string,
): Promise<MobileImageMounterService> {
  await requireCatalogService(udid, MobileImageMounterService.RSD_SERVICE_NAME);
  return new MobileImageMounterService(udid);
}

/**
 * Start the SpringBoard service for the given device UDID.
 */
export async function startSpringboardService(
  udid: string,
): Promise<SpringBoardService> {
  await requireCatalogService(udid, SpringBoardService.RSD_SERVICE_NAME);
  return new SpringBoardService(udid);
}

/**
 * Start the misagent service for the given device UDID.
 */
export async function startMisagentService(
  udid: string,
): Promise<MisagentService> {
  await requireCatalogService(udid, MisagentService.RSD_SERVICE_NAME);
  return new MisagentService(udid);
}

/**
 * Start the power assertion service for the given device UDID.
 */
export async function startPowerAssertionService(
  udid: string,
): Promise<PowerAssertionService> {
  await requireCatalogService(udid, PowerAssertionService.RSD_SERVICE_NAME);
  return new PowerAssertionService(udid);
}

/**
 * Start the CoreDevice HID Indigo service for the given device UDID.
 */
export async function startHidIndigoService(
  udid: string,
): Promise<HidIndigoService> {
  await requireCatalogService(udid, HidIndigoService.RSD_SERVICE_NAME);
  return new HidIndigoService(udid);
}

/**
 * Start the CoreDevice AppService for the given device UDID.
 *
 * Provides app and process management (list apps, launch/terminate apps, list
 * processes, signal processes, uninstall apps) over RemoteXPC.
 */
export async function startAppServiceService(
  udid: string,
): Promise<AppServiceService> {
  await requireCatalogService(udid, AppServiceService.RSD_SERVICE_NAME);
  return new AppServiceService(udid);
}

const RSD_SYSLOG_BINARY_SERVICE_NAME = 'com.apple.os_trace_relay.shim.remote';
const RSD_SYSLOG_TEXT_SERVICE_NAME = 'com.apple.syslog_relay.shim.remote';

/** Options for {@link startXCTestServices}. */
export interface StartXCTestServicesOptions {
  /** Also resolve and return an InstallationProxyService for app lookup. */
  includeInstallationProxy?: boolean;
}

/**
 * Start the syslog service for the given device UDID.
 * Validates the os_trace_relay shim is present in the tunnel catalog.
 */
export async function startSyslogService(
  udid: string,
): Promise<SyslogServiceType> {
  await requireCatalogService(udid, RSD_SYSLOG_BINARY_SERVICE_NAME);
  return new SyslogService(udid);
}

/**
 * Resolve the syslog binary service (os_trace_relay RemoteXPC shim).
 */
export async function startSyslogBinaryService(
  udid: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  return startSyslogWithServiceName(udid, RSD_SYSLOG_BINARY_SERVICE_NAME);
}

/**
 * Resolve the syslog text-relay service (iOS 18+ RemoteXPC shim).
 */
export async function startSyslogTextService(
  udid: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  return startSyslogWithServiceName(udid, RSD_SYSLOG_TEXT_SERVICE_NAME);
}

/**
 * Start AFC service over RemoteXPC shim.
 */
export async function startAfcService(udid: string): Promise<AfcService> {
  await requireCatalogService(udid, AfcService.RSD_SERVICE_NAME);
  return new AfcService(udid);
}

/**
 * Start streaming zip_conduit service over RemoteXPC shim.
 */
export async function startZipConduitService(
  udid: string,
): Promise<ZipConduitService> {
  await requireCatalogService(udid, ZipConduitService.RSD_SERVICE_NAME);
  return new ZipConduitService(udid);
}

/**
 * Start CrashReportsService over RemoteXPC shim.
 */
export async function startCrashReportsService(
  udid: string,
): Promise<CrashReportsService> {
  await requireCatalogServices(udid, [
    CrashReportsService.RSD_COPY_MOBILE_NAME,
    CrashReportsService.RSD_CRASH_MOVER_NAME,
  ]);
  return new CrashReportsService(udid);
}

/**
 * Start the house arrest service for the given device UDID.
 */
export async function startHouseArrestService(
  udid: string,
): Promise<HouseArrestService> {
  await requireCatalogService(udid, HouseArrestService.RSD_SERVICE_NAME);
  return new HouseArrestService(udid);
}

/**
 * Start the installation proxy service for the given device UDID.
 */
export async function startInstallationProxyService(
  udid: string,
): Promise<InstallationProxyService> {
  await requireCatalogService(udid, InstallationProxyService.RSD_SERVICE_NAME);
  return new InstallationProxyService(udid);
}

/**
 * Start the web inspector service for the given device UDID.
 */
export async function startWebInspectorService(
  udid: string,
): Promise<WebInspectorService> {
  await requireCatalogService(udid, WebInspectorService.RSD_SERVICE_NAME);
  return new WebInspectorService(udid);
}

/**
 * Start the DVT secure socket proxy service and instrument clients.
 */
export async function startDVTService(udid: string): Promise<DVTInstruments> {
  await requireCatalogService(
    udid,
    DVTSecureSocketProxyService.RSD_SERVICE_NAME,
  );

  const dvtService = new DVTSecureSocketProxyService(udid);
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
    sysmontap: new Sysmontap(dvtService),
  };
}

/**
 * Start the testmanagerd service for the given device UDID.
 */
export async function startTestmanagerdService(
  udid: string,
): Promise<DvtTestmanagedProxyService> {
  await requireCatalogService(
    udid,
    DvtTestmanagedProxyService.RSD_SERVICE_NAME,
  );

  const testmanagerdService = new DvtTestmanagedProxyService(udid);
  await testmanagerdService.connect();
  return testmanagerdService;
}

/**
 * Start all services needed for an XCTest session using one registry catalog read.
 */
export async function startXCTestServices(
  udid: string,
  options?: StartXCTestServicesOptions,
): Promise<XCTestServices> {
  const serviceNames = [
    DvtTestmanagedProxyService.RSD_SERVICE_NAME,
    DVTSecureSocketProxyService.RSD_SERVICE_NAME,
  ];
  if (options?.includeInstallationProxy) {
    serviceNames.push(InstallationProxyService.RSD_SERVICE_NAME);
  }
  await requireCatalogServices(udid, serviceNames);

  let execTestmanagerd: DvtTestmanagedProxyService | null = null;
  let controlTestmanagerd: DvtTestmanagedProxyService | null = null;
  let dvtService: DVTSecureSocketProxyService | null = null;
  let installationProxy: InstallationProxyService | undefined;
  try {
    execTestmanagerd = new DvtTestmanagedProxyService(udid);
    await execTestmanagerd.connect();

    controlTestmanagerd = new DvtTestmanagedProxyService(udid);
    await controlTestmanagerd.connect();

    dvtService = new DVTSecureSocketProxyService(udid);
    await dvtService.connect();

    if (options?.includeInstallationProxy) {
      installationProxy = new InstallationProxyService(udid);
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

async function requireCatalogService(
  udid: string,
  serviceName: string,
): Promise<void> {
  await resolveTunnelService(udid, serviceName, { waitMs: SERVICE_WAIT_MS });
}

async function requireCatalogServices(
  udid: string,
  serviceNames: string[],
): Promise<void> {
  await resolveTunnelServicePorts(udid, serviceNames, {
    waitMs: SERVICE_WAIT_MS,
  });
}

async function startSyslogWithServiceName(
  udid: string,
  serviceName: string,
): Promise<{ syslogService: SyslogServiceType; serviceDescriptor: Service }> {
  const { port } = await resolveTunnelService(udid, serviceName, {
    waitMs: SERVICE_WAIT_MS,
  });
  return {
    syslogService: new SyslogService(udid),
    serviceDescriptor: { serviceName, port: String(port) },
  };
}
