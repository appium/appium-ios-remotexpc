/**
 * Common type definitions for the appium-ios-remotexpc library
 */
import type { PacketData } from 'appium-ios-tuntap';
import { EventEmitter } from 'events';

import type { ServiceConnection } from '../service-connection.js';
import type { BaseService, Service } from '../services/ios/base-service.js';
import type { InterfaceOrientation } from '../services/ios/springboard-service/index.js';
import type { RemoteXpcConnection } from './remote-xpc/remote-xpc-connection.js';
import type { Device } from './usbmux/index.js';

/**
 * Represents a value that can be stored in a plist
 */
export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
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
