/**
 * Common type definitions for the appium-ios-remotexpc library
 */
import type { PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';

import type { ServiceConnection } from '../service-connection.js';
import type { BaseService, Service } from '../services/ios/base-service.js';
import type { iOSApplication } from '../services/ios/dvt/instruments/application-listing.js';
import type { LocationCoordinates } from '../services/ios/dvt/instruments/location-simulation.js';
import { ProvisioningProfile } from '../services/ios/misagent/provisioning-profile.js';
import type { PowerAssertionOptions } from '../services/ios/power-assertion/index.js';
import { PowerAssertionType } from '../services/ios/power-assertion/index.js';
import type { InterfaceOrientation } from '../services/ios/springboard-service/index.js';
import type { RemoteXpcConnection } from './remote-xpc/remote-xpc-connection.js';
import type { Device } from './usbmux/index.js';

export type { PowerAssertionOptions };
export { PowerAssertionType };

/**
 * UID (Unique Identifier) interface for plist references
 * Used in NSKeyedArchiver format
 */
export interface IPlistUID {
  value: number;
}

export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | IPlistUID
  | PlistArray
  | PlistDictionary
  | null;

/**
 * Represents an array in a plist
 */
export type PlistArray = Array<PlistValue>;

/**
 * Represents a dictionary in a plist
 */
export interface PlistDictionary {
  [key: string]: PlistValue;
}

/**
 * Represents a message that can be sent or received via plist
 */
export type PlistMessage = PlistDictionary;

/**
 * Represents a value that can be encoded in XPC protocol
 */
export type XPCValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | Uint8Array
  | XPCArray
  | XPCDictionary
  | null;

/**
 * Represents an array in XPC protocol
 */
export type XPCArray = Array<XPCValue>;

/**
 * Represents a dictionary in XPC protocol
 */
export interface XPCDictionary {
  [key: string]: XPCValue;
}

/**
 * Represents a callback function for handling responses
 */
export type ResponseCallback<T> = (data: T) => void;

export interface TunnelRegistryEntry {
  /** Unique device identifier */
  udid: string;
  /** Numeric device ID */
  deviceId: number;
  /** IP address of the tunnel */
  address: string;
  /** Remote Service Discovery (RSD) port number */
  rsdPort: number;
  /** Packet stream port number */
  packetStreamPort: number;
  /** Type of connection (e.g., 'USB', 'Network') */
  connectionType: string;
  /** Product identifier of the device */
  productId: number;
  /** Timestamp when the tunnel was created (milliseconds since epoch) */
  createdAt: number;
  /** Timestamp when the tunnel was last updated (milliseconds since epoch) */
  lastUpdated: number;
}

export interface TunnelRegistry {
  /** Map of UDID to tunnel registry entries */
  tunnels: Record<string, TunnelRegistryEntry>;
  /** Metadata about the registry */
  metadata: {
    /** ISO 8601 timestamp of last registry update */
    lastUpdated: string;
    /** Total number of tunnels in the registry */
    totalTunnels: number;
    /** Number of currently active tunnels */
    activeTunnels: number;
  };
}

export interface SocketInfo {
  /** Device server information */
  server: Device;
  /** Port number for the socket connection */
  port: number;
  /** Device-specific information */
  deviceInfo: {
    /** Unique device identifier */
    udid: string;
    /** IP address of the device */
    address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    rsdPort?: number;
  };
}

export interface TunnelResult {
  /** Device information */
  device: Device;
  /** Tunnel connection details */
  tunnel: {
    /** IP address of the tunnel */
    Address: string;
    /** Optional Remote Service Discovery (RSD) port number */
    RsdPort?: number;
  };
  /** Optional packet stream port number */
  packetStreamPort?: number;
  /** Indicates whether the tunnel creation was successful */
  success: boolean;
  /** Error message if tunnel creation failed */
  error?: string;
}

/**
 * Represents the instance side of DiagnosticsService
 */
export interface DiagnosticsService extends BaseService {
  /**
   * Restart the device
   * @returns Promise that resolves when the restart request is sent
   */
  restart(): Promise<PlistDictionary>;

  /**
   * Shutdown the device
   * @returns Promise that resolves when the shutdown request is sent
   */
  shutdown(): Promise<PlistDictionary>;

  /**
   * Put the device in sleep mode
   * @returns Promise that resolves when the sleep request is sent
   */
  sleep(): Promise<PlistDictionary>;

  /**
   * Query IORegistry
   * @param options Options for the IORegistry query
   * @returns Object containing the IORegistry information
   */
  ioregistry(options?: {
    plane?: string;
    name?: string;
    ioClass?: string;
    returnRawJson?: boolean;
    timeout?: number;
  }): Promise<PlistDictionary[] | Record<string, any>>;
}

/**
 * Represents the static side of DiagnosticsService
 */
export interface NotificationProxyService extends BaseService {
  /**
   * Connect to the notification proxy service
   * @returns Promise resolving to the ServiceConnection instance
   */
  connectToNotificationProxyService(): Promise<ServiceConnection>;
  /**
   * Observe a notification
   * @param notification The notification name to subscribe to
   * @returns Promise that resolves when the subscription request is sent
   */
  observe(notification: string): Promise<PlistDictionary>;
  /**
   * Post a notification
   * @param notification The notification name to post
   * @returns Promise that resolves when the post request is sent
   */
  post(notification: string): Promise<PlistDictionary>;
  /**
   * Expect notifications as an async generator
   * @param timeout Timeout in milliseconds
   * @returns AsyncGenerator yielding PlistMessage objects
   */
  expectNotifications(timeout?: number): AsyncGenerator<PlistMessage>;
  /**
   * Expect a single notification
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the expected notification
   */
  expectNotification(timeout?: number): Promise<PlistMessage>;
}

/**
 * Represents the PowerAssertionService for preventing system sleep
 */
export interface PowerAssertionService extends BaseService {
  /**
   * Create a power assertion to prevent system sleep
   * @param options Options for creating the power assertion
   * @returns Promise that resolves when the assertion is created
   */
  createPowerAssertion(options: PowerAssertionOptions): Promise<void>;

  /**
   * Close the connection to the power assertion service
   * @returns Promise that resolves when the connection is closed
   */
  close(): Promise<void>;
}

/**
 * Represents the static side of MobileConfigService
 */
export interface MobileConfigService extends BaseService {
  /**
   * Connect to the mobile config service
   * @returns Promise resolving to the ServiceConnection instance
   */
  connectToMobileConfigService(): Promise<ServiceConnection>;
  /**
   * Get all profiles of iOS devices
   * @returns {Promise<PlistDictionary>}
   * e.g.
   * {
   *   OrderedIdentifiers: [ '2fac1c2b3d684843189b2981c718b0132854a847a' ],
   *   ProfileManifest: {
   *     '2fac1c2b3d684843189b2981c718b0132854a847a': {
   *       Description: 'Charles Proxy CA (7 Dec 2020, MacBook-Pro.local)',
   *       IsActive: true
   *     }
   *   },
   *   ProfileMetadata: {
   *     '2fac1c2b3d684843189b2981c718b0132854a847a': {
   *       PayloadDisplayName: 'Charles Proxy CA (7 Dec 2020, MacBook-Pro.local)',
   *       PayloadRemovalDisallowed: false,
   *       PayloadUUID: 'B30005CC-BC73-4E42-8545-8DA6C44A8A71',
   *       PayloadVersion: 1
   *     }
   *   },
   *   Status: 'Acknowledged'
   * }
   */
  getProfileList(): Promise<PlistDictionary>;
  /**
   * Install profile to iOS device
   * @param {String} path  must be a certificate file .PEM .CER and more formats
   * e.g: /Downloads/charles-certificate.pem
   */
  installProfileFromPath(path: string): Promise<void>;
  /**
   * Install profile to iOS device from buffer
   * @param {Buffer} payload  must be a certificate file .PEM .CER and more formats
   */
  installProfileFromBuffer(payload: Buffer): Promise<void>;
  /**
   * Remove profile from iOS device
   * @param {String} identifier Query identifier list through getProfileList method
   */
  removeProfile(identifier: string): Promise<void>;
}

/**
 * Represents the static side of DiagnosticsService
 */
export interface DiagnosticsServiceConstructor {
  /**
   * Service name for Remote Service Discovery
   */
  readonly RSD_SERVICE_NAME: string;
  /**
   * Creates a new DiagnosticsService instance
   * @param address Tuple containing [host, port]
   */
  new (address: [string, number]): DiagnosticsService;
}

/**
 * Represents a DiagnosticsService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface DiagnosticsServiceWithConnection {
  /** The DiagnosticsService instance */
  diagnosticsService: DiagnosticsService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents a NotificationProxyService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface NotificationProxyServiceWithConnection {
  /** The NotificationProxyService instance */
  notificationProxyService: NotificationProxyService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents a MobileConfigService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface MobileConfigServiceWithConnection {
  /** The MobileConfigService instance */
  mobileConfigService: MobileConfigService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents a PowerAssertionService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface PowerAssertionServiceWithConnection {
  /** The PowerAssertionService instance */
  powerAssertionService: PowerAssertionService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * DVT (Developer Tools) service interface
 */
export interface DVTSecureSocketProxyService extends BaseService {
  /**
   * Connect to the DVT service
   */
  connect(): Promise<void>;

  /**
   * Get supported identifiers (capabilities)
   * @example
   * const capabilities = dvtService.getSupportedIdentifiers();
   * // Example output:
   * // {
   * //   "com.apple.instruments.server.services.processcontrol.capability.memorylimits": 1,
   * //   "com.apple.instruments.server.services.coreml.perfrunner": 4,
   * //   "com.apple.instruments.server.services.processcontrolbydictionary": 4,
   * //   "com.apple.instruments.server.services.graphics.coreanimation.immediate": 1,
   * //   // ... more identifiers
   * // }
   */
  getSupportedIdentifiers(): PlistDictionary;

  /**
   * Create a channel for a specific identifier
   * @param identifier The channel identifier
   * @returns The created channel
   */
  makeChannel(identifier: string): Promise<any>;

  /**
   * Close the DVT service connection
   */
  close(): Promise<void>;
}

/**
 * Location simulation service interface
 */
export interface LocationSimulationService {
  /**
   * Set the simulated location
   * @param latitude The latitude
   * @param longitude The longitude
   */
  setLocation(latitude: number, longitude: number): Promise<void>;

  /**
   * Set the simulated location using the LocationCoordinates type.
   * @param coordinates The location coordinates
   */
  set(coordinates: LocationCoordinates): Promise<void>;

  /**
   * Clear/stop location simulation
   *
   * Note: This method is safe to call even if no location simulation is currently active.
   */
  clear(): Promise<void>;
}

/**
 * Condition profile information
 */
export interface ConditionProfile {
  identifier: string;
  description?: string;
  [key: string]: any;
}

/**
 * Condition group information
 */
export interface ConditionGroup {
  identifier: string;
  profiles: ConditionProfile[];
  [key: string]: any;
}

/**
 * Condition inducer service interface
 */
export interface ConditionInducerService {
  /**
   * List all available condition inducers and their profiles
   *
   * Each group in the response contains information about whether a condition
   * is currently active via the `isActive` field and which profile is active
   * via the `activeProfile` field.
   *
   * @returns Array of condition groups with their available profiles
   *
   * @example
   * ```typescript
   * const groups = await conditionInducer.list();
   * // Example response:
   * // [
   * //   {
   * //     "profiles": [
   * //       {
   * //         "name": "100% packet loss",
   * //         "identifier": "SlowNetwork100PctLoss",
   * //         "description": "Name: 100% Loss Scenario\nDownlink Bandwidth: 0 Mbps\nDownlink Latency: 0 ms\nDownlink Packet Loss Ratio: 100%\nUplink Bandwidth: 0 Mbps\nUplink Latency: 0 ms\nUplink Packet Loss Ratio: 100%"
   * //       },
   * //       // ... more profiles
   * //     ],
   * //     "profilesSorted": true,
   * //     "identifier": "SlowNetworkCondition",
   * //     "isDestructive": false,
   * //     "isInternal": false,
   * //     "activeProfile": "",
   * //     "name": "Network Link",
   * //     "isActive": false
   * //   },
   * //   // ... more groups
   * // ]
   * ```
   */
  list(): Promise<ConditionGroup[]>;

  /**
   * Set a specific condition profile
   *
   * Note: If a condition is already active, attempting to set a new one will
   * throw an error: {'NSLocalizedDescription': 'A condition is already active.'}
   * You must call disable() first before setting a different condition.
   *
   * Available profile identifiers include (but may vary by iOS version):
   * - Network profiles: SlowNetwork100PctLoss, SlowNetworkVeryBadNetwork,
   *   SlowNetworkEdgeBad, SlowNetworkEdgeAverage, SlowNetworkEdgeGood,
   *   SlowNetworkEdge, SlowNetwork2GRural, SlowNetwork2GUrban,
   *   SlowNetwork3GAverage, SlowNetwork3GGood, SlowNetwork3G,
   *   SlowNetworkLTE, SlowNetworkWiFi, SlowNetworkWiFi80211AC,
   *   SlowNetworkDSL, SlowNetworkHighLatencyDNS
   * - Thermal profiles: ThermalFair, ThermalSerious, ThermalCritical
   * - GPU profiles: GPUPerformanceStateMin, GPUPerformanceStateMid, GPUPerformanceStateMax
   * - And others depending on device capabilities
   *
   * Use list() to see all available profiles for your device.
   *
   * @param profileIdentifier The identifier of the profile to enable
   * @throws Error if the profile identifier is not found
   * @throws Error if a condition is already active
   */
  set(profileIdentifier: string): Promise<void>;

  /**
   * Disable the currently active condition
   *
   * Note: This method is idempotent - calling it when no condition is active
   * will not throw an error.
   */
  disable(): Promise<void>;
}

/**
 * Screenshot service interface
 */
export interface ScreenshotService {
  /**
   * Capture a screenshot from the device
   * @returns The screenshot data as a Buffer in PNG format, unscaled with the same dimensions as the device resolution
   */
  getScreenshot(): Promise<Buffer>;
}

/**
 * Application listing service interface
 */
export interface AppListService {
  /**
   * Get the list of iOS applications on the device
   * @returns {Promise<iOSApplication>}
   * e.g.
   * [
   *  {
   *    ExtensionDictionary: { NSExtensionPointIdentifier: 'com.apple.mlhost.worker', ... },
   *    Version: '1.0',
   *    DisplayName: 'ModelMonitoringLighthousePlugin',
   *    CFBundleIdentifier: 'com.apple.aeroml.ModelMonitoringLighthouse.ModelMonitoringLighthousePlugin',
   *    BundlePath: '/System/Library/ExtensionKit/Extensions/ModelMonitoringLighthousePlugin.appex',
   *    ExecutableName: 'ModelMonitoringLighthousePlugin',
   *    Restricted: 1,
   *    Type: 'PluginKit',
   *    PluginIdentifier: 'com.apple.aeroml.ModelMonitoringLighthouse.ModelMonitoringLighthousePlugin',
   *    PluginUUID: 'AF17A1FE-E454-57C8-B963-0832FD71AB08'
   *   },
   *   ...
   * ]
   */
  list(): Promise<iOSApplication[]>;
}
/**
 * Graphics service interface for OpenGL/graphics monitoring
 */
export interface GraphicsService {
  /**
   * Async iterator for graphics logging
   * Eg: {
   *  'Device Utilization %': 27,
   *  lastRecoveryTime: 0,
   *  'Renderer Utilization %': 26,
   *  'Alloc system memory': 99909632,
   *  'In use system memory (driver)': 0,
   *  recoveryCount: 0,
   *  'Tiler Utilization %': 27,
   *  SplitSceneCount: 0,
   *  'Allocated PB Size': 2097152,
   *  XRVideoCardRunTimeStamp: 1088,
   *  'In use system memory': 28180480,
   *  TiledSceneBytes: 327680,
   *  IOGLBundleName: 'Built-In',
   *  CoreAnimationFramesPerSecond: 0
   * }
   */
  messages(): AsyncGenerator<unknown, void, unknown>;
}

/**
 * Process information
 */
export interface ProcessInfo {
  /** Process identifier (may be negative for system services) */
  pid: number;

  /** Process name */
  name?: string;

  /** Indicates whether the process is an application */
  isApplication: boolean;

  /** Bundle identifier for application processes */
  bundleIdentifier?: string;

  /** Full path to the executable */
  realAppName?: string;

  /** Raw device start timestamp */
  startDate?: {
    /** Mach-based timestamp value */
    'NS.time': number;
  };

  /** Whether crash analysis should include corpse sampling */
  shouldAnalyzeWithCorpse?: boolean;
}

/**
 * DeviceInfo service interface for accessing device information,
 * file system, and process management
 */
export interface DeviceInfoService {
  /**
   * List directory contents
   * @param path The directory path to list
   * @returns Array of filenames
   */
  ls(path: string): Promise<string[]>;

  /**
   * Get executable path for a process
   * @param pid The process identifier
   * @returns The full path to the executable
   */
  execnameForPid(pid: number): Promise<string>;

  /**
   * Get list of running processes
   * @returns Array of process information
   * @example
   * ```typescript
   * const processes = await deviceInfo.proclist();
   * // Example response:
   * // [
   * //   {
   * //     name: 'audioaccessoryd',
   * //     startDate: { 'NS.time': 786563887.8186979 },
   * //     isApplication: false,
   * //     pid: 77,
   * //     realAppName: '/usr/libexec/audioaccessoryd'
   * //   },
   * //   {
   * //     name: 'dmd',
   * //     startDate: { 'NS.time': 786563890.2724509 },
   * //     isApplication: false,
   * //     pid: -102,
   * //     realAppName: '/usr/libexec/dmd'
   * //   },
   * //   ...
   * // ]
   * ```
   */
  proclist(): Promise<ProcessInfo[]>;

  /**
   * Check if a process is running
   * @param pid The process identifier
   * @returns true if running, false otherwise
   */
  isRunningPid(pid: number): Promise<boolean>;

  /**
   * Get hardware information
   * @returns Hardware information object
   * @example
   * ```typescript
   * const hwInfo = await deviceInfo.hardwareInformation();
   * // Example response:
   * // {
   * //   numberOfPhysicalCpus: 6,
   * //   hwCPUsubtype: 2,
   * //   numberOfCpus: 6,
   * //   hwCPUtype: 16777228,
   * //   hwCPU64BitCapable: 1,
   * //   ProcessorTraceState: {
   * //     HWTraceVersion: '{\n  "lib_ver": "libhwtrace @ tag libhwtrace-118.1",\n  "api_ver": 21,\n  ...\n}',
   * //     Streaming: false,
   * //     ProdTraceSupported: false,
   * //     AllocatedBufferSize: 0,
   * //     HWSupported: false,
   * //     HWConfigured: false,
   * //     RequestedBufferSize: 0,
   * //     DevTraceSupported: false
   * //   }
   * // }
   * ```
   */
  hardwareInformation(): Promise<any>;

  /**
   * Get network information
   * @returns Network information object
   * @example
   * ```typescript
   * const networkInfo = await deviceInfo.networkInformation();
   * // Example response:
   * // {
   * //   en2: 'Ethernet Adapter (en2)',
   * //   en0: 'Wi-Fi',
   * //   en1: 'Ethernet Adapter (en1)',
   * //   lo0: 'Loopback'
   * // }
   * ```
   */
  networkInformation(): Promise<any>;

  /**
   * Get mach time information
   * @returns Mach time info array containing [machAbsoluteTime, numer, denom, machContinuousTime, systemTime, timezone]
   * @example
   * ```typescript
   * const machTime = await deviceInfo.machTimeInfo();
   * // Example response:
   * // [
   * //   1536005260807,      // machAbsoluteTime
   * //   125,                // numer
   * //   3,                  // denom
   * //   1713684132688,      // machContinuousTime
   * //   1764942215.065243,  // systemTime
   * //   'Asia/Kolkata'      // timezone
   * // ]
   * ```
   */
  machTimeInfo(): Promise<any>;

  /**
   * Get mach kernel name
   * @returns Kernel name string
   * @example
   * ```typescript
   * const kernelName = await deviceInfo.machKernelName();
   * // Example response:
   * // '/mach.release.t8030'
   * ```
   */
  machKernelName(): Promise<string>;

  /**
   * Get kernel performance event database
   * @returns KPEP database object or null
   * @example
   * ```typescript
   * const kpep = await deviceInfo.kpepDatabase();
   * // Example response:
   * // {
   * //   system: {
   * //     cpu: {
   * //       config_counters: 1020,
   * //       marketing_name: 'Apple A13',
   * //       fixed_counters: 3,
   * //       aliases: { ... },
   * //       events: { ... },
   * //       architecture: 'arm64',
   * //       power_counters: -32
   * //     }
   * //   },
   * //   internal: false,
   * //   id: 'cpu_100000c_2_462504d2',
   * //   name: 'a13',
   * //   version: [1, 0]
   * // }
   * ```
   */
  kpepDatabase(): Promise<any | null>;

  /**
   * Get trace code mappings
   * @returns Object mapping trace codes (as hex strings) to descriptions
   * @example
   * ```typescript
   * const codes = await deviceInfo.traceCodes();
   * // Example response:
   * // {
   * //   '0x1020000': 'KTrap_DivideError',
   * //   '0x1020004': 'KTrap_Debug',
   * //   '0x1020008': 'KTrap_NMI',
   * //   '0x102000c': 'KTrap_Int3',
   * //   '0x1020010': 'KTrap_Overflow',
   * //   '0x1020014': 'KTrap_BoundRange',
   * //   ...
   * // }
   * ```
   */
  traceCodes(): Promise<Record<string, string>>;

  /**
   * Get username for UID
   * @param uid The user identifier
   * @returns Username string
   */
  nameForUid(uid: number): Promise<string>;

  /**
   * Get group name for GID
   * @param gid The group identifier
   * @returns Group name string
   */
  nameForGid(gid: number): Promise<string>;
}

/**
 * DVT service with connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface DVTServiceWithConnection {
  /** The DVTSecureSocketProxyService instance */
  dvtService: DVTSecureSocketProxyService;
  /** The LocationSimulation service instance */
  locationSimulation: LocationSimulationService;
  /** The ConditionInducer service instance */
  conditionInducer: ConditionInducerService;
  /** The Screenshot service instance */
  screenshot: ScreenshotService;
  /** The Application Listing service instance */
  appListing: AppListService;
  /** The Graphics service instance */
  graphics: GraphicsService;
  /** The DeviceInfo service instance */
  deviceInfo: DeviceInfoService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents the WebInspectorService
 */
export interface WebInspectorService extends BaseService {
  /**
   * Send a message to the WebInspector service
   * @param selector The RPC selector (e.g., '_rpc_reportIdentifier:')
   * @param args The arguments dictionary for the message
   * @returns Promise that resolves when the message is sent
   */
  sendMessage(selector: string, args?: PlistDictionary): Promise<void>;

  /**
   * Listen to messages from the WebInspector service using async generator
   * @yields PlistMessage - Messages received from the WebInspector service
   */
  listenMessage(): AsyncGenerator<PlistMessage, void, unknown>;

  /**
   * Stop listening to messages
   */
  stopListening(): void;

  /**
   * Close the connection and clean up resources
   */
  close(): Promise<void>;

  /**
   * Get the connection ID being used for this service
   * @returns The connection identifier
   */
  getConnectionId(): string;

  /**
   * Request application launch
   * @param bundleId The bundle identifier of the application to launch
   */
  requestApplicationLaunch(bundleId: string): Promise<void>;

  /**
   * Get connected applications
   */
  getConnectedApplications(): Promise<void>;

  /**
   * Forward get listing for an application
   * @param appId The application identifier
   */
  forwardGetListing(appId: string): Promise<void>;

  /**
   * Forward automation session request
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param capabilities Optional session capabilities
   */
  forwardAutomationSessionRequest(
    sessionId: string,
    appId: string,
    capabilities?: PlistDictionary,
  ): Promise<void>;

  /**
   * Forward socket setup for inspector connection
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param automaticallyPause Whether to automatically pause (defaults to true)
   */
  forwardSocketSetup(
    sessionId: string,
    appId: string,
    pageId: number,
    automaticallyPause?: boolean,
  ): Promise<void>;

  /**
   * Forward socket data to a page
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param data The data to send (will be JSON stringified)
   */
  forwardSocketData(
    sessionId: string,
    appId: string,
    pageId: number,
    data: any,
  ): Promise<void>;

  /**
   * Forward indicate web view
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param enable Whether to enable indication
   */
  forwardIndicateWebView(
    appId: string,
    pageId: number,
    enable: boolean,
  ): Promise<void>;
}

/**
 * Represents a WebInspectorService instance with its associated RemoteXPC connection
 * This allows callers to properly manage the connection lifecycle
 */
export interface WebInspectorServiceWithConnection {
  /** The WebInspectorService instance */
  webInspectorService: WebInspectorService;
  /** The RemoteXPC connection that can be used to close the connection */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Options for configuring syslog capture
 */
export interface SyslogOptions {
  /** Process ID to filter logs by */
  pid?: number;
  /** Whether to enable verbose logging */
  enableVerboseLogging?: boolean;
}

/**
 * Interface for a packet source that can provide packet data
 */
export interface PacketSource {
  /** Add a packet consumer to receive packets */
  addPacketConsumer: (consumer: PacketConsumer) => void;
  /** Remove a packet consumer */
  removePacketConsumer: (consumer: PacketConsumer) => void;
}

/**
 * Interface for a packet consumer that can process packets
 */
export interface PacketConsumer {
  /** Handler for received packets */
  onPacket: (packet: PacketData) => void;
}

/**
 * Represents the instance side of SyslogService
 */
export interface SyslogService extends EventEmitter {
  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param packetSource Source of packet data (can be PacketConsumer or AsyncIterable)
   * @param options Configuration options for syslog capture
   * @returns Promise resolving to the initial response from the service
   */
  start(
    service: Service,
    packetSource: PacketSource | AsyncIterable<PacketData>,
    options?: SyslogOptions,
  ): Promise<void>;

  /**
   * Stops capturing syslog data
   * @returns Promise that resolves when capture is stopped
   */
  stop(): Promise<void>;

  /**
   * Restart the device
   * @param service Service information
   * @returns Promise that resolves when the restart request is sent
   */
  restart(service: Service): Promise<void>;

  /**
   * Event emitter for 'start' events
   */
  on(event: 'start', listener: (response: any) => void): this;

  /**
   * Event emitter for 'stop' events
   */
  on(event: 'stop', listener: () => void): this;

  /**
   * Event emitter for 'message' events
   */
  on(event: 'message', listener: (message: string) => void): this;

  /**
   * Event emitter for 'plist' events
   */
  on(event: 'plist', listener: (data: any) => void): this;

  /**
   * Event emitter for 'error' events
   */
  on(event: 'error', listener: (error: Error) => void): this;

  /**
   * Event emitter for any events
   */
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Represents the static side of SyslogService
 */
export interface SyslogServiceConstructor {
  /**
   * Creates a new SyslogService instance
   * @param address Tuple containing [host, port]
   */
  new (address: [string, number]): SyslogService;
}

/**
 * Represents the instance side of MobileImageMounterService
 */
export interface MobileImageMounterService extends BaseService {
  /**
   * Lookup for mounted images by type
   * @param imageType Type of image, 'Personalized' by default
   * @returns Promise resolving to array of signatures of mounted images
   */
  lookup(imageType?: string): Promise<Buffer[]>;

  /**
   * Check if personalized image is mounted
   * @returns Promise resolving to boolean indicating if personalized image is mounted
   */
  isPersonalizedImageMounted(): Promise<boolean>;

  /**
   * Mount personalized image for device (iOS 17+)
   * @param imageFilePath The file path of the image (.dmg)
   * @param buildManifestFilePath The build manifest file path (.plist)
   * @param trustCacheFilePath The trust cache file path (.trustcache)
   */
  mount(
    imageFilePath: string,
    buildManifestFilePath: string,
    trustCacheFilePath: string,
  ): Promise<void>;

  /**
   * Unmount image from device
   * @param mountPath The mount path to unmount, defaults to '/System/Developer'
   */
  unmountImage(mountPath?: string): Promise<void>;

  /**
   * Query developer mode status (iOS 16+)
   * @returns Promise resolving to boolean indicating if developer mode is enabled
   */
  queryDeveloperModeStatus(): Promise<boolean>;

  /**
   * Query personalization nonce (for personalized images)
   * @param personalizedImageType Optional personalized image type
   * @returns Promise resolving to personalization nonce
   */
  queryNonce(personalizedImageType?: string): Promise<Buffer>;

  /**
   * Query personalization identifiers from the device
   * @returns Promise resolving to personalization identifiers
   */
  queryPersonalizationIdentifiers(): Promise<PlistDictionary>;

  /**
   * Copy devices list
   * @returns Promise resolving to array of mounted devices
   */
  copyDevices(): Promise<any[]>;

  /**
   * Query personalization manifest for a specific image
   * @param imageType The image type (e.g., 'DeveloperDiskImage')
   * @param signature The image signature/hash
   * @returns Promise resolving to personalization manifest
   */
  queryPersonalizationManifest(
    imageType: string,
    signature: Buffer,
  ): Promise<Buffer>;
}

/**
 * Represents the static side of MobileImageMounterService
 */
export interface MobileImageMounterServiceConstructor {
  /**
   * RSD service name for the mobile image mounter service
   */
  readonly RSD_SERVICE_NAME: string;

  /**
   * Creates a new MobileImageMounterService instance
   * @param address Tuple containing [host, port]
   */
  new (address: [string, number]): MobileImageMounterService;
}

/**
 * Represents a MobileImageMounterService instance with its associated RemoteXPC connection
 */
export interface MobileImageMounterServiceWithConnection {
  /** The MobileImageMounterService instance */
  mobileImageMounterService: MobileImageMounterService;
  /** The RemoteXPC connection for service management */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents the instance side of SpringboardService
 */
export interface SpringboardService extends BaseService {
  /**
   * Gets the icon state
   * @returns Promise resolving to the icon state
   * e.g.
   * [
   *     {
   *       displayIdentifier: 'com.apple.MobileSMS',
   *       displayName: 'Messages',
   *       iconModDate: 2025-09-03T12:55:46.400Z,
   *       bundleVersion: '1402.700.63.2.1',
   *       bundleIdentifier: 'com.apple.MobileSMS'
   *     },
   *     {
   *       displayIdentifier: 'com.apple.measure',
   *       displayName: 'Measure',
   *       iconModDate: 2025-09-03T12:55:49.522Z,
   *       bundleVersion: '175.100.3.0.1',
   *       bundleIdentifier: 'com.apple.measure'
   *     },
   *     ...
   *  ]
   */
  getIconState(): Promise<PlistDictionary>;

  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation (maybe?)
   * Sets the icon state
   * @param newState where is the payload from getIconState
   */
  setIconState(newState: PlistDictionary[]): Promise<void>;

  /**
   * Gets the icon PNG data for a given bundle ID
   * @param bundleID The bundle ID of the app
   * @returns {Promise<Buffer>} which is the PNG data of the app icon
   */
  getIconPNGData(bundleID: string): Promise<Buffer>;

  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation
   * Add payload structure when it is fixed
   * Gets wallpaper info
   * @param wallpaperName The name of the wallpaper
   * @returns Promise resolving to the wallpaper info
   */
  getWallpaperInfo(wallpaperName: string): Promise<PlistDictionary>;

  /**
   * Gets homescreen icon metrics
   * @returns {Promise<PlistDictionary>}
   * e.g.
   * {
   *   homeScreenIconHeight: 64,
   *   homeScreenIconMaxPages: 15,
   *   homeScreenWidth: 414,
   *   homeScreenHeight: 896,
   *   homeScreenIconDockMaxCount: 4,
   *   homeScreenIconFolderMaxPages: 15,
   *   homeScreenIconWidth: 64,
   *   homeScreenIconRows: 6,
   *   homeScreenIconColumns: 4,
   *   homeScreenIconFolderColumns: 3,
   *   homeScreenIconFolderRows: 3
   * }
   */
  getHomescreenIconMetrics(): Promise<PlistDictionary>;

  /**
   * Gets the current interface orientation
   * @returns {Promise<InterfaceOrientation>}
   * 1 = Portrait
   * 2 = PortraitUpsideDown
   * 3 = Landscape
   * 4 = LandscapeHomeToLeft
   */
  getInterfaceOrientation(): Promise<InterfaceOrientation>;

  /**
   * Gets wallpaper preview image for homescreen and lockscreen
   * @param wallpaperName
   * @returns {Promise<Buffer>} which is a wallpaper preview image
   */
  getWallpaperPreviewImage(
    wallpaperName: 'homescreen' | 'lockscreen',
  ): Promise<Buffer>;

  /**
   * TODO: This does not work currently due to a bug in Apple protocol implementation
   * Use getWallpaperPreviewImage('homescreen') instead
   * Gets wallpaper PNG data
   * @param wallpaperName
   * @returns {Promise<Buffer>}
   */
  getWallpaperPNGData(wallpaperName: string): Promise<Buffer>;
}

/**
 * Represents a SpringboardService instance with its associated RemoteXPC connection
 */
export interface SpringboardServiceWithConnection {
  /** The SpringboardService instance */
  springboardService: SpringboardService;
  /** The RemoteXPC connection for service management */
  remoteXPC: RemoteXpcConnection;
}

/**
 * Represents the instance side of MisagentService where provisioning profiles can be managed
 * @remarks
 * Provisioning profiles are Apple configuration files (.mobileprovision) that contain:
 * - Certificates, identifiers, and device information
 * - App entitlements and permissions
 * - Expiration dates and platform restrictions
 */
export interface MisagentService extends BaseService {
  /**
   * Installs a provisioning profile from a file path
   * @param path The file path of the provisioning profile (.mobileprovision file)
   */
  installProfileFromPath(path: string): Promise<void>;
  /**
   * Installs a provisioning profile from a buffer
   * @param payload The buffer containing the provisioning profile data
   */
  installProfile(payload: Buffer): Promise<void>;
  /**
   * Removes a provisioning profile by its UUID
   * @param uuid The uuid of the provisioning profile to remove
   */
  removeProfile(uuid: string): Promise<void>;

  /**
   * Fetching all provisioning profiles from the device
   * This can be used for listing installed provisioning profiles and backing them up
   * @returns {Promise<ProvisioningProfile[]>}
   * e.g.
   *  [
   *  {
   *    "AppIDName": "Apple Development: John Doe (ABCDE12345)",
   *    "ApplicationIdentifierPrefix": [
   *       "ABCDE12345"
   *     ],
   *  "CreationDate": "2023-10-01T12:34:56Z",
   *   "Platform": [
   *    "iOS",
   *    "xrOS",
   *  ],
   * IsXcodeManaged": false,
   * "DeveloperCertificates": [ <Buffer ...> ],
   * "Entitlements": {
   *    "application-identifier": "ABCDE12345.com.example.app",
   *    "get-task-allow": true,
   *    ...
   *  },
   *  "ExpirationDate": "2024-10-01T12:34:56Z",
   *  "Name": "Apple Development: John Doe (ABCDE12345)",
   *  "UUID": "12345678-90AB-CDEF-1234-567890ABCDEF",
   *  "Version": 1,
   *  ...
   * },
   * ]
   * @example
   * const profiles = await misagentService.fetchAll();
   * profiles.forEach(profile => {
   *   console.log(`Profile: ${profile.plist.Name}`);
   *   console.log(`UUID: ${profile.plist.UUID}`);
   *   console.log(`Expires: ${profile.plist.ExpirationDate}`);
   * });
   */
  fetchAll(): Promise<ProvisioningProfile[]>;
}

export interface MisagentServiceWithConnection {
  misagentService: MisagentService;
  remoteXPC: RemoteXpcConnection;
}
