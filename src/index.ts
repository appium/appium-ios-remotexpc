import { STRONGBOX_CONTAINER_NAME } from './constants.js';
import { createLockdownServiceByUDID } from './lib/lockdown/index.js';
import {
  PacketStreamClient,
  PacketStreamServer,
  TunnelManager,
} from './lib/tunnel/index.js';
import {
  TunnelRegistryServer,
  startTunnelRegistryServer,
} from './lib/tunnel/tunnel-registry-server.js';
import { Usbmux, createUsbmux } from './lib/usbmux/index.js';
import * as Services from './services.js';
import { startCoreDeviceProxy } from './services/ios/tunnel-service/index.js';

export type { Device as UsbmuxDevice } from './lib/usbmux/index.js';
export type { RemoteXpcConnection } from './lib/remote-xpc/remote-xpc-connection.js';
export type { AfcService } from './services/ios/afc/index.js';
export type { InstallationProxyService } from './services/ios/installation-proxy/index.js';

export type {
  CrashReportsService,
  CrashReportsPullOptions,
  CrashReportsServiceWithConnection,
  DiagnosticsService,
  MobileImageMounterService,
  NotificationProxyService,
  MobileConfigService,
  PowerAssertionService,
  PowerAssertionOptions,
  SpringboardService,
  WebInspectorService,
  MisagentService,
  SyslogService,
  HouseArrestService,
  DVTSecureSocketProxyService,
  LocationSimulationService,
  ConditionInducerService,
  ScreenshotService,
  GraphicsService,
  DeviceInfoService,
  NetworkMonitorService,
  ProcessInfo,
  ConditionProfile,
  ConditionGroup,
  SocketInfo,
  TunnelResult,
  TunnelRegistry,
  TunnelRegistryEntry,
  DiagnosticsServiceWithConnection,
  HouseArrestServiceWithConnection,
  InstallationProxyServiceWithConnection,
  MobileImageMounterServiceWithConnection,
  NotificationProxyServiceWithConnection,
  MobileConfigServiceWithConnection,
  PowerAssertionServiceWithConnection,
  SpringboardServiceWithConnection,
  WebInspectorServiceWithConnection,
  MisagentServiceWithConnection,
  DVTServiceWithConnection,
  NetworkAddress,
  InterfaceDetectionEvent,
  ConnectionDetectionEvent,
  ConnectionUpdateEvent,
  NetworkEvent,
  ProcessControlService,
  ProcessLaunchOptions,
  OutputReceivedEvent,
} from './lib/types.js';
export { PowerAssertionType } from './lib/types.js';
export { NetworkMessageType } from './services/ios/dvt/instruments/network-monitor.js';
export {
  STRONGBOX_CONTAINER_NAME,
  createUsbmux,
  Services,
  Usbmux,
  TunnelManager,
  PacketStreamServer,
  PacketStreamClient,
  createLockdownServiceByUDID,
  startCoreDeviceProxy,
  TunnelRegistryServer,
  startTunnelRegistryServer,
};
