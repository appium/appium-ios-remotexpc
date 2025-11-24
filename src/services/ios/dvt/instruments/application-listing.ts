import { getLogger } from '../../../../lib/logger.js';
import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = getLogger('ApplicationListing');

export interface iOSApplication {
  /** Display name of the application/plugin */
  DisplayName: string;

  /** Bundle identifier in reverse domain notation */
  CFBundleIdentifier: string;

  /** Full path to the application bundle */
  BundlePath: string;

  /** Version string of the application */
  Version: string;

  /** Name of the main executable file */
  ExecutableName: string;

  /** Access restriction flag (0 = unrestricted, 1 = restricted) */
  Restricted: number;

  /** Bundle type (e.g., 'PluginKit', 'Application') */
  Type: string;

  /** Unique identifier for plugins */
  PluginIdentifier: string;

  /** UUID for the plugin instance */
  PluginUUID: string;

  /** Extension configuration with variable structure */
  ExtensionDictionary?: Record<string, any>;

  /** Bundle identifier of the containing app (plugins only) */
  ContainerBundleIdentifier?: string;

  /** Path to the container app bundle (plugins only) */
  ContainerBundlePath?: string;
}

/**
 * Application Listing service for retrieving installed applications
 */
export class ApplicationListing {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.device.applictionListing';

  private channel: Channel | null = null;

  constructor(private readonly dvt: DVTSecureSocketProxyService) {}

  /**
   * Initialize the application listing channel
   */
  async initialize(): Promise<void> {
    if (this.channel) {
      return;
    }
    this.channel = await this.dvt.makeChannel(ApplicationListing.IDENTIFIER);
  }

  /**
   * Get the list of installed applications from the device
   * @returns {Promise<iOSApplication[]>}
   */
  async list(): Promise<iOSApplication[]> {
    await this.initialize();

    const args = new MessageAux().appendObj(null).appendObj(null);

    await this.channel!.call(
      'installedApplicationsMatching_registerUpdateToken_',
    )(args);

    const result = await this.channel!.receivePlist();

    if (!result) {
      log.warn(
        'Received null/undefined response from installedApplicationsMatching',
      );
      return [];
    }

    if (Array.isArray(result)) {
      return result;
    }

    throw new Error(
      `Unexpected response format from installedApplicationsMatching: ${JSON.stringify(result)}`,
    );
  }
}
