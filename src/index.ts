import {
  STRONGBOX_CONTAINER_NAME,
  TUNNEL_CONTAINER_NAME,
} from './constants.js';
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
  SyslogEntry,
  SyslogLabel,
  SyslogLogLevel,
} from './services/ios/syslog-service/syslog-entry-parser.js';

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
  SendMessageOptions,
  TestmanagerdService,
  TestmanagerdServiceWithConnection,
  XCTestServices,
} from './lib/types.js';
export { PowerAssertionType } from './lib/types.js';
export { NetworkMessageType } from './services/ios/dvt/instruments/network-monitor.js';
export { XCTestConfigurationEncoder } from './services/ios/testmanagerd/xctestconfiguration.js';
export type { XCTestConfigurationParams } from './services/ios/testmanagerd/xctestconfiguration.js';
export { ProcessControl } from './services/ios/dvt/instruments/process-control.js';
export {
  XCUITestService,
  XCTestRunner,
  createXCTestRunner,
  runXCTest,
} from './services/ios/testmanagerd/xcuitest.js';
export {
  XCTestRunError,
  getXctestNameFromBundleId,
  parseCallback,
} from './services/ios/testmanagerd/xctest-types.js';
export type {
  XCUITestOptions,
  XCTestRunnerOptions,
  XCTestRunResult,
  XCTestRunStage,
  XCTestEvent,
  XCTestSummary,
} from './services/ios/testmanagerd/xctest-types.js';
export { createBinaryPlist } from './lib/plist/index.js';
export {
  AppleTVPairingService,
  UserInputService,
} from './lib/apple-tv/pairing/index.js';
export { AppleTVTunnelService } from './lib/apple-tv/tunnel/index.js';
export type { AppleTVPairingResult } from './lib/apple-tv/types.js';

export {
  STRONGBOX_CONTAINER_NAME,
  TUNNEL_CONTAINER_NAME,
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
