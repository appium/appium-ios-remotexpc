import { strongbox } from '@appium/strongbox';

import { RemoteXpcConnection } from './lib/remote-xpc/remote-xpc-connection.js';
import { TunnelManager } from './lib/tunnel/index.js';
import { TunnelApiClient } from './lib/tunnel/tunnel-api-client.js';
import type {
  DVTServiceWithConnection,
  DiagnosticsServiceWithConnection,
  MisagentServiceWithConnection,
  MobileConfigServiceWithConnection,
  MobileImageMounterServiceWithConnection,
  NotificationProxyServiceWithConnection,
  PowerAssertionServiceWithConnection,
  SpringboardServiceWithConnection,
  SyslogService as SyslogServiceType,
  WebInspectorServiceWithConnection,
} from './lib/types.js';
import AfcService from './services/ios/afc/index.js';
import DiagnosticsService from './services/ios/diagnostic-service/index.js';
import { DVTSecureSocketProxyService } from './services/ios/dvt/index.js';
import { ApplicationListing } from './services/ios/dvt/instruments/application-listing.js';
import { ConditionInducer } from './services/ios/dvt/instruments/condition-inducer.js';
import { DeviceInfo } from './services/ios/dvt/instruments/device-info.js';
import { Graphics } from './services/ios/dvt/instruments/graphics.js';
import { LocationSimulation } from './services/ios/dvt/instruments/location-simulation.js';
import { Screenshot } from './services/ios/dvt/instruments/screenshot.js';
import { MisagentService } from './services/ios/misagent/index.js';
import { MobileConfigService } from './services/ios/mobile-config/index.js';
import MobileImageMounterService from './services/ios/mobile-image-mounter/index.js';
import { NotificationProxyService } from './services/ios/notification-proxy/index.js';
import { PowerAssertionService } from './services/ios/power-assertion/index.js';
import { SpringBoardService } from './services/ios/springboard-service/index.js';
import SyslogService from './services/ios/syslog-service/index.js';
import { WebInspectorService } from './services/ios/webinspector/index.js';

const APPIUM_XCUITEST_DRIVER_NAME = 'appium-xcuitest-driver';
const TUNNEL_REGISTRY_PORT = 'tunnelRegistryPort';

export async function startDiagnosticsService(
  udid: string,
): Promise<DiagnosticsServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const diagnosticsService = remoteXPC.findService(
    DiagnosticsService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    diagnosticsService: new DiagnosticsService([
      tunnelConnection.host,
      parseInt(diagnosticsService.port, 10),
    ]),
  };
}

export async function startNotificationProxyService(
  udid: string,
): Promise<NotificationProxyServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const notificationProxyService = remoteXPC.findService(
    NotificationProxyService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    notificationProxyService: new NotificationProxyService([
      tunnelConnection.host,
      parseInt(notificationProxyService.port, 10),
    ]),
  };
}

export async function startMobileConfigService(
  udid: string,
): Promise<MobileConfigServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const mobileConfigService = remoteXPC.findService(
    MobileConfigService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    mobileConfigService: new MobileConfigService([
      tunnelConnection.host,
      parseInt(mobileConfigService.port, 10),
    ]),
  };
}

export async function startMobileImageMounterService(
  udid: string,
): Promise<MobileImageMounterServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const mobileImageMounterService = remoteXPC.findService(
    MobileImageMounterService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    mobileImageMounterService: new MobileImageMounterService([
      tunnelConnection.host,
      parseInt(mobileImageMounterService.port, 10),
    ]),
  };
}

export async function startSpringboardService(
  udid: string,
): Promise<SpringboardServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const springboardService = remoteXPC.findService(
    SpringBoardService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    springboardService: new SpringBoardService([
      tunnelConnection.host,
      parseInt(springboardService.port, 10),
    ]),
  };
}

export async function startMisagentService(
  udid: string,
): Promise<MisagentServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const misagentService = remoteXPC.findService(
    MisagentService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    misagentService: new MisagentService([
      tunnelConnection.host,
      parseInt(misagentService.port, 10),
    ]),
  };
}

export async function startPowerAssertionService(
  udid: string,
): Promise<PowerAssertionServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const powerAssertionService = remoteXPC.findService(
    PowerAssertionService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    powerAssertionService: new PowerAssertionService([
      tunnelConnection.host,
      parseInt(powerAssertionService.port, 10),
    ]),
  };
}

export async function startSyslogService(
  udid: string,
): Promise<SyslogServiceType> {
  const { tunnelConnection } = await createRemoteXPCConnection(udid);
  return new SyslogService([tunnelConnection.host, tunnelConnection.port]);
}

/**
 * Start AFC service over RemoteXPC shim.
 * Resolves the AFC service port via RemoteXPC and returns a ready-to-use AfcService instance.
 */
export async function startAfcService(udid: string): Promise<AfcService> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const afcDescriptor = remoteXPC.findService(AfcService.RSD_SERVICE_NAME);
  return new AfcService([
    tunnelConnection.host,
    parseInt(afcDescriptor.port, 10),
  ]);
}

export async function startWebInspectorService(
  udid: string,
): Promise<WebInspectorServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const webInspectorService = remoteXPC.findService(
    WebInspectorService.RSD_SERVICE_NAME,
  );
  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    webInspectorService: new WebInspectorService([
      tunnelConnection.host,
      parseInt(webInspectorService.port, 10),
    ]),
  };
}

export async function startDVTService(
  udid: string,
): Promise<DVTServiceWithConnection> {
  const { remoteXPC, tunnelConnection } = await createRemoteXPCConnection(udid);
  const dvtServiceDescriptor = remoteXPC.findService(
    DVTSecureSocketProxyService.RSD_SERVICE_NAME,
  );

  // Create DVT service instance
  const dvtService = new DVTSecureSocketProxyService([
    tunnelConnection.host,
    parseInt(dvtServiceDescriptor.port, 10),
  ]);

  // Connect to DVT service
  await dvtService.connect();

  // Create instrument services
  const locationSimulation = new LocationSimulation(dvtService);
  const conditionInducer = new ConditionInducer(dvtService);
  const screenshot = new Screenshot(dvtService);
  const appListing = new ApplicationListing(dvtService);
  const graphics = new Graphics(dvtService);
  const deviceInfo = new DeviceInfo(dvtService);

  return {
    remoteXPC: remoteXPC as RemoteXpcConnection,
    dvtService,
    locationSimulation,
    conditionInducer,
    screenshot,
    appListing,
    graphics,
    deviceInfo,
  };
}

export async function createRemoteXPCConnection(udid: string) {
  const tunnelConnection = await getTunnelInformation(udid);
  const remoteXPC = await startService(
    tunnelConnection.host,
    tunnelConnection.port,
  );
  return { remoteXPC, tunnelConnection };
}

// #region Private Functions

async function getTunnelInformation(udid: string) {
  const box = strongbox(APPIUM_XCUITEST_DRIVER_NAME);
  const item = await box.createItem(TUNNEL_REGISTRY_PORT);
  const tunnelRegistryPort = await item.read();
  if (tunnelRegistryPort === undefined) {
    throw new Error(
      'Tunnel registry port not found. Please run the tunnel creation script first: sudo appium driver run xcuitest tunnel-creation',
    );
  }
  const tunnelApiClient = new TunnelApiClient(
    `http://127.0.0.1:${tunnelRegistryPort}/remotexpc/tunnels`,
  );
  const tunnelExists = await tunnelApiClient.hasTunnel(udid);
  if (!tunnelExists) {
    throw new Error(
      `No tunnel found for device ${udid}. Please run the tunnel creation script first: sudo appium driver run xcuitest tunnel-creation`,
    );
  }
  const tunnelConnection = await tunnelApiClient.getTunnelConnection(udid);
  if (!tunnelConnection) {
    throw new Error(
      `Failed to get tunnel connection details for device ${udid}`,
    );
  }
  return tunnelConnection;
}

async function startService(
  host: string,
  port: number,
): Promise<RemoteXpcConnection> {
  return await TunnelManager.createRemoteXPCConnection(host, port);
}

// #endregion
