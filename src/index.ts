import {STRONGBOX_CONTAINER_NAME, TUNNEL_CONTAINER_NAME} from './constants.js';
import {createLockdownServiceByUDID, createLockdownServiceForTunnel} from './lib/lockdown/index.js';
import {DevicePortForwarder} from './lib/port-forwarding/index.js';
import type {RsdServiceCatalogClient as RsdServiceCatalogClientType} from './lib/remote-xpc/rsd-service-catalog-client.js';
import {
  TunnelManager,
  TunnelReadinessCoordinator,
  discoverServices,
  servicesToCatalog,
  watchTunnelRegistryOnDead,
  watchTunnelRegistrySockets,
} from './lib/tunnel/index.js';
import {TunnelRegistryServer, startTunnelRegistryServer} from './lib/tunnel/tunnel-registry-server.js';
import {Usbmux, createUsbmux} from './lib/usbmux/index.js';
import * as Services from './services.js';
import {startCoreDeviceProxyTcp} from './services/ios/tunnel-service/index.js';

export type {Device as UsbmuxDevice} from './lib/usbmux/index.js';
export type {
  DevicePortForwarderEvents,
  DevicePortForwarderOptions,
  UpstreamSocketConnector,
} from './lib/port-forwarding/index.js';
export type {RsdServiceCatalogClient} from './lib/remote-xpc/rsd-service-catalog-client.js';
export {XPCUUID} from './lib/remote-xpc/xpc-uuid.js';
/**
 * @deprecated Use RsdServiceCatalogClient instead.
 */
export type RemoteXpcConnection = RsdServiceCatalogClientType;
export type {AfcService} from './services/ios/afc/index.js';
export {AfcConnectionError} from './services/ios/afc/errors.js';
export type {
  ZipConduitService,
  ZipConduitProgressCallback,
  ZipConduitInstallOptions,
  ZipConduitStreamStats,
} from './services/ios/zipconduit/index.js';
export type {InstallationProxyService} from './services/ios/installation-proxy/index.js';
export {
  HID_BUTTON_STATE_CANCELED,
  HID_BUTTON_STATE_DOWN,
  HID_BUTTON_STATE_UP,
  HidIndigoService,
} from './services/ios/hid-indigo/index.js';
export type {
  HidButtonEventOptions,
  HidButtonName,
  HidButtonPressOptions,
  HidButtonState,
} from './services/ios/hid-indigo/index.js';
export {CoreDeviceError, CoreDeviceService} from './services/ios/core-device/core-device-service.js';
export type {CoreDeviceInvokeOptions} from './services/ios/core-device/core-device-service.js';
export {AppService} from './services/ios/app-service/index.js';
export type {
  AppServiceProcessToken,
  InstalledApp,
  LaunchApplicationOptions,
  LaunchedApplication,
  ListAppsOptions,
} from './services/ios/app-service/index.js';
export {PasteboardService} from './services/ios/pasteboard/index.js';
export {AccessibilityAuditService} from './services/ios/accessibility-audit/index.js';
export type {AxDeviceSetting} from './services/ios/accessibility-audit/index.js';
export {AxAuditDtxTransport} from './services/ios/accessibility-audit/dtx-transport.js';
export type {InvokeOptions as AxInvokeOptions} from './services/ios/accessibility-audit/dtx-transport.js';
export {AX_OBJECT_TYPE, deserializeAxObject} from './services/ios/accessibility-audit/ax-deserialize.js';
export {AxPoint, toAxRect} from './services/ios/accessibility-audit/ax-values.js';
export type {AxRect} from './services/ios/accessibility-audit/ax-values.js';
export {
  serializeAxAttribute,
  serializeAxElement,
  toAxElement,
  toInspectedElement,
} from './services/ios/accessibility-audit/ax-element.js';
export type {
  AxElement,
  AxElementAttribute,
  AxInspectedElement,
  AxInspectorSection,
} from './services/ios/accessibility-audit/ax-element.js';
export {serializeAxSetting} from './services/ios/accessibility-audit/index.js';
export type {InspectOptions, RunAuditOptions, AxAuditIssue} from './services/ios/accessibility-audit/index.js';
export {CoreDeviceInfoService} from './services/ios/device-info/index.js';
export type {
  CoreDeviceAttributes,
  CoreDeviceDisplayInfo,
  CoreDeviceLockState,
} from './services/ios/device-info/index.js';
export {DeviceControlService} from './services/ios/device-control/index.js';
export type {DeviceOrientationState, RotateDirection} from './services/ios/device-control/index.js';
export {ConfigurationService} from './services/ios/configuration/index.js';
export type {
  ColorFilterState,
  ColorFilterType,
  DeviceTextSize,
  SetColorFilterOptions,
  UserInterfaceStyle,
} from './services/ios/configuration/index.js';
export {DisplayService, REMOTE_CONTROL_UNSUPPORTED_ERROR_CODE} from './services/ios/display/index.js';
export type {
  MediaStreamAnswer,
  MediaStreamEndpoint,
  MediaStreamServerStatus,
  MediaSupportInfo,
  StartAudioStreamOptions,
  StartVideoStreamOptions,
} from './services/ios/display/index.js';
export {ScreenStreamCapture, recordScreenToFile} from './services/ios/display/video/screen-stream-capture.js';
export type {
  RecordScreenOptions,
  RecordScreenResult,
  ScreenStreamCaptureOptions,
} from './services/ios/display/video/screen-stream-capture.js';
export {AccessUnitAssembler} from './services/ios/display/video/access-unit-assembler.js';
export type {
  HevcParameterSets,
  ScreenStreamStats,
  VideoAccessUnit,
} from './services/ios/display/video/access-unit-assembler.js';
export {AudioStreamCapture, recordAudioToFile} from './services/ios/display/audio/audio-stream-capture.js';
export type {
  AudioAccessUnit,
  AudioStreamCaptureOptions,
  AudioStreamStats,
  RecordAudioOptions,
  RecordAudioResult,
} from './services/ios/display/audio/audio-stream-capture.js';
export {recordScreenAndAudioToFiles} from './services/ios/display/recording/av-capture.js';
export type {
  RecordScreenAndAudioOptions,
  RecordScreenAndAudioResult,
} from './services/ios/display/recording/av-capture.js';
export {ffmpegMuxCommandBuilder, formatMuxCommand} from './services/ios/display/recording/mux-command.js';
export type {MuxCommand, MuxCommandBuilder, MuxInput} from './services/ios/display/recording/mux-command.js';
export {
  AAC_ELD_ASC_48K_STEREO_480,
  AAC_ELD_ASC_DEVICE_ADVERTISED,
  AAC_ELD_CHANNELS,
  AAC_ELD_FORMAT,
  AAC_ELD_FRAMES_PER_PACKET,
  AAC_ELD_RTP_PAYLOAD_TYPE,
  AAC_ELD_SAMPLE_RATE,
  aacEldDurationMs,
} from './services/ios/display/audio/aac-eld.js';
export type {AacEldFormat} from './services/ios/display/audio/aac-eld.js';
export {M4aFileWriter, buildM4a} from './services/ios/display/audio/m4a-writer.js';
export type {BuildM4aOptions, M4aFileWriterResult} from './services/ios/display/audio/m4a-writer.js';
export {
  HevcDepacketizer,
  HevcNalType,
  buildHevcDecoderConfigurationRecord,
  hevcCodecStringFromSps,
  isKeyNalType,
  nalTypeOf,
  toAnnexB,
  toLengthPrefixed,
} from './services/ios/display/video/hevc.js';
export {UdpMediaReceiver, isNextSequence, parseRtpPacket} from './services/ios/display/transport/rtp.js';
export type {RtpPacket, UdpMediaReceiverOptions} from './services/ios/display/transport/rtp.js';
export {PacketLossReporter} from './services/ios/display/transport/packet-loss-reporter.js';
export type {PacketLossReporterOptions} from './services/ios/display/transport/packet-loss-reporter.js';
export {
  buildMediaBlobAudio,
  buildMediaBlobVideo,
  buildNegotiatorOfferAudio,
  buildNegotiatorOfferVideo,
  buildRemoteEndpointInfo,
} from './services/ios/display/negotiation/media-stream-offer.js';
export type {
  AudioMediaBlobOptions,
  HostEndpointIdentity,
  NegotiatorOfferOptions,
  VideoMediaBlobOptions,
} from './services/ios/display/negotiation/media-stream-offer.js';

export type {SyslogEntry, SyslogLabel, SyslogLogLevel} from './services/ios/syslog-service/syslog-entry-parser.js';

export type {
  CrashReport,
  CrashReportMetadata,
  CrashReportsService,
  CrashReportsPullOptions,
  CrashReportsWatchOptions,
  SysdiagnoseOptions,
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
  EnergyMonitorService,
  ProcessInfo,
  ConditionProfile,
  ConditionGroup,
  SocketInfo,
  TunnelResult,
  TunnelRegistry,
  TunnelRegistryEntry,
  ActivityTraceTapService,
  DVTInstruments,
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
  XCTestServices,
  SysmontapService,
  SysmontapOptions,
  SysmonSample,
  SysmonProcessInfo,
  SysmonSystemInfo,
} from './lib/types.js';
export {PowerAssertionType} from './lib/types.js';
export {NetworkMessageType} from './services/ios/dvt/instruments/network-monitor.js';
export type {EnergyMetrics, EnergyMonitorSample} from './services/ios/dvt/instruments/energy-monitor.js';
export {ActivityTraceTap} from './services/ios/dvt/instruments/activity-trace-tap.js';
export type {ActivityTraceMessage, ActivityTraceTapOptions} from './services/ios/dvt/instruments/activity-trace-tap.js';
export {TunnelAvailabilityError, getTunnelForDevice} from './lib/tunnel/tunnel-availability.js';
export {
  resolveTunnelService,
  resolveTunnelServicePorts,
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
} from './lib/tunnel/tunnel-service-resolver.js';
export type {TunnelEndpoint} from './lib/tunnel/tunnel-api-client.js';
export {XCTestConfigurationEncoder} from './services/ios/testmanagerd/xctestconfiguration.js';
export type {XCTestConfigurationParams} from './services/ios/testmanagerd/xctestconfiguration.js';
export {ProcessControl} from './services/ios/dvt/instruments/process-control.js';
export {Sysmontap} from './services/ios/dvt/instruments/sysmontap.js';
export {XCUITestService, XCTestRunner, createXCTestRunner, runXCTest} from './services/ios/testmanagerd/xcuitest.js';
export {XCTestAttachment} from './services/ios/testmanagerd/xctest-attachment.js';
export {
  XCTestRunError,
  XCTestEventType,
  createDeferred,
  getXctestNameFromBundleId,
  parseCallback,
} from './services/ios/testmanagerd/xctest-common.js';
export type {
  XCUITestOptions,
  XCUITestServiceEvents,
  XCTestRunnerEvents,
  XCTestRunnerOptions,
  XCTestRunResult,
  XCTestRunStage,
  XCTestEvent,
  XCTestSummary,
} from './services/ios/testmanagerd/xctest-common.js';
export {createBinaryPlist} from './lib/plist/index.js';
export {AppleTVPairingService, UserInputService} from './lib/apple-tv/pairing/index.js';
export {AppleTVTunnelService} from './lib/apple-tv/tunnel/index.js';
export type {AppleTVPairingDiscoveryOptions, AppleTVPairingOptions} from './lib/apple-tv/pairing/index.js';
export type {AppleTVDiscoveryOptions, AppleTVTunnelOptions} from './lib/apple-tv/tunnel/index.js';
export type {AppleTVDevice, AppleTVPairingResult} from './lib/apple-tv/types.js';
export type {LockdownService} from './lib/lockdown/index.js';

export {connectViaTunnel, connectViaUsbmux} from './lib/port-forwarding/index.js';

export {
  STRONGBOX_CONTAINER_NAME,
  TUNNEL_CONTAINER_NAME,
  createUsbmux,
  Services,
  Usbmux,
  DevicePortForwarder,
  TunnelManager,
  discoverServices,
  servicesToCatalog,
  TunnelReadinessCoordinator,
  createLockdownServiceForTunnel,
  createLockdownServiceByUDID,
  startCoreDeviceProxyTcp,
  TunnelRegistryServer,
  startTunnelRegistryServer,
  watchTunnelRegistrySockets,
  watchTunnelRegistryOnDead,
};
