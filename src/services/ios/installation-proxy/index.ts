import {getLogger} from '../../../lib/logger.js';
import type {PlistDictionary} from '../../../lib/types.js';
import {type ServiceConnection} from '../../../service-connection.js';
import {BaseService} from '../base-service.js';
import type {
  AppInfo,
  ApplicationType,
  BrowseOptions,
  BrowseResponse,
  InstallOptions,
  LookupOptions,
  LookupResponse,
  ProgressCallback,
  ProgressResponse,
  UninstallOptions,
} from './types.js';

const log = getLogger('InstallationProxyService');

export const DEFAULT_APPLICATION_TYPE = 'Any';

export const DEFAULT_RETURN_ATTRIBUTES = [
  'CFBundleIdentifier',
  'CFBundleName',
  'CFBundleDisplayName',
  'CFBundleVersion',
  'CFBundleShortVersionString',
  'ApplicationType',
];

export const SIZE_ATTRIBUTES = ['CFBundleIdentifier', 'StaticDiskUsage', 'DynamicDiskUsage'];

/**
 * Maximum duration for browse/lookup operations in milliseconds
 * Browse operations are lightweight and should complete quickly
 */
export const MAX_BROWSE_DURATION_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Maximum duration for install/uninstall/upgrade operations in milliseconds
 * Safety limit to prevent endless loops while allowing time for large apps
 */
export const MAX_INSTALL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * InstallationProxyService provides an API to manage app installation and queries
 */
export class InstallationProxyService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.installation_proxy.shim.remote';
  private readonly timeout: number;
  private connection: ServiceConnection | null = null;

  constructor(udid: string, timeout: number = 30000) {
    super(udid);
    this.timeout = timeout;
  }

  /**
   * Browse installed applications
   */
  async browse(options: BrowseOptions = {}): Promise<AppInfo[]> {
    const {applicationType = DEFAULT_APPLICATION_TYPE, returnAttributes = DEFAULT_RETURN_ATTRIBUTES} = options;

    const clientOptions: Record<string, string | string[]> = {
      ApplicationType: applicationType,
    };

    // Only set ReturnAttributes when it's an array.
    if (Array.isArray(returnAttributes)) {
      clientOptions.ReturnAttributes = returnAttributes;
    }

    const request: PlistDictionary = {
      Command: 'Browse',
      ClientOptions: clientOptions,
    };

    const conn = await this.getConnection();
    conn.sendPlist(request);

    const result: AppInfo[] = [];
    const startTime = performance.now();

    while (true) {
      if (performance.now() - startTime > MAX_BROWSE_DURATION_MS) {
        throw new Error(
          `Browse operation exceeded maximum duration (${MAX_BROWSE_DURATION_MS / 1000}s). ` +
            'This likely indicates a stalled operation or API issue.',
        );
      }

      const response = (await conn.receive(this.timeout)) as BrowseResponse;

      this.checkForError(response);

      if (response.CurrentList && response.CurrentList.length > 0) {
        result.push(...response.CurrentList);
      }

      if (response.Status === 'Complete') {
        break;
      }
    }

    return result;
  }

  /**
   * Lookup application information by bundle IDs
   */
  async lookup(bundleIds?: string[], options: Partial<LookupOptions> = {}): Promise<Record<string, AppInfo>> {
    const clientOptions: Record<string, string | string[] | ApplicationType> = {
      ...options,
    };

    if (bundleIds && bundleIds.length > 0) {
      clientOptions.BundleIDs = bundleIds;
    }

    const request: PlistDictionary = {
      Command: 'Lookup',
      ClientOptions: clientOptions,
    };

    const conn = await this.getConnection();
    const response = (await conn.sendPlistRequest(request, this.timeout)) as LookupResponse;

    this.checkForError(response);

    if (!response.LookupResult) {
      log.warn('Lookup returned no results');
      return {};
    }

    return response.LookupResult;
  }

  /**
   * Get all installed applications with optional size calculation
   */
  async getApps(
    applicationType: ApplicationType = DEFAULT_APPLICATION_TYPE,
    calculateSizes: boolean = false,
    bundleIds?: string[],
  ): Promise<Record<string, AppInfo>> {
    const options: LookupOptions = {
      applicationType,
    };

    if (calculateSizes) {
      // Combine default attributes with size attributes in a single call
      options.returnAttributes = [...DEFAULT_RETURN_ATTRIBUTES, 'StaticDiskUsage', 'DynamicDiskUsage'];
    }

    if (bundleIds && bundleIds.length > 0) {
      options.bundleIDs = bundleIds;
    }

    return await this.lookup(bundleIds, options);
  }

  /**
   * Install an application from a path on the device
   * @param packagePath Path to the IPA file on the device (e.g., '/PublicStaging/app.ipa')
   * @param options Installation options
   * @param progressCallback Optional callback for progress updates
   */
  async install(packagePath: string, options: InstallOptions = {}, progressCallback?: ProgressCallback): Promise<void> {
    const {timeoutMs, ...clientOptions} = options;

    const request: PlistDictionary = {
      Command: 'Install',
      PackagePath: packagePath,
      ClientOptions: clientOptions as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback, timeoutMs);
  }

  /**
   * Uninstall an application by bundle identifier
   * @param bundleIdentifier Bundle ID of the app to uninstall
   * @param options Uninstallation options (including optional timeoutMs)
   * @param progressCallback Optional callback for progress updates
   */
  async uninstall(
    bundleIdentifier: string,
    options: UninstallOptions = {},
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    const {timeoutMs, ...clientOptions} = options;

    const request: PlistDictionary = {
      Command: 'Uninstall',
      ApplicationIdentifier: bundleIdentifier,
      ClientOptions: clientOptions as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback, timeoutMs);
  }

  /**
   * Upgrade an existing application
   * @param packagePath Path to the IPA file on the device (e.g., '/PublicStaging/app.ipa')
   * @param options Installation options (including optional timeoutMs)
   * @param progressCallback Optional callback for progress updates
   */
  async upgrade(packagePath: string, options: InstallOptions = {}, progressCallback?: ProgressCallback): Promise<void> {
    const {timeoutMs, ...clientOptions} = options;

    const request: PlistDictionary = {
      Command: 'Upgrade',
      PackagePath: packagePath,
      ClientOptions: clientOptions as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback, timeoutMs);
  }

  /**
   * Check if an app is installed on the device
   * @param bundleIdentifier Bundle ID of the app to check
   * @returns Object with installation status and version info if installed
   */
  async isAppInstalled(bundleIdentifier: string): Promise<{
    isInstalled: boolean;
    version?: string;
    appInfo?: AppInfo;
  }> {
    try {
      const installedApps = await this.lookup([bundleIdentifier]);
      const appInfo = installedApps[bundleIdentifier];

      if (!appInfo) {
        return {isInstalled: false};
      }

      const version = appInfo.CFBundleShortVersionString || appInfo.CFBundleVersion;

      return {
        isInstalled: true,
        version,
        appInfo,
      };
    } catch (error) {
      log.error(`Error checking if app is installed: ${error}`);
      // If lookup fails, assume app is not installed
      return {isInstalled: false};
    }
  }

  /**
   * Close the connection
   */
  close(): void {
    try {
      if (this.connection) {
        this.connection.close();
      }
    } catch (error) {
      log.error('Error closing connection:', error);
    } finally {
      // Always set to null even if close fails
      this.connection = null;
    }
  }

  private async getConnection(): Promise<ServiceConnection> {
    if (this.connection) {
      return this.connection;
    }

    this.connection = await this.startLockdownService(InstallationProxyService.RSD_SERVICE_NAME, {
      createConnectionTimeout: this.timeout,
    });

    const startServiceResponse = await this.connection.receive(this.timeout);

    if (!startServiceResponse) {
      throw new Error('No response received from service');
    }

    if (startServiceResponse.Request !== 'StartService') {
      throw new Error(`Expected StartService response, got: ${JSON.stringify(startServiceResponse)}`);
    }

    if (startServiceResponse.Error) {
      const errorDesc = startServiceResponse.ErrorDescription ?? 'Unknown error';
      throw new Error(`Service start failed: ${startServiceResponse.Error} - ${errorDesc}`);
    }

    return this.connection;
  }

  private async executeWithProgress(
    request: PlistDictionary,
    progressCallback?: ProgressCallback,
    timeoutMs: number = MAX_INSTALL_DURATION_MS,
  ): Promise<void> {
    const conn = await this.getConnection();
    conn.sendPlist(request);

    const startTime = performance.now();

    while (true) {
      if (performance.now() - startTime > timeoutMs) {
        throw new Error(
          `Operation exceeded maximum duration (${timeoutMs / 1000}s). ` +
            'This likely indicates a stalled operation or API issue.',
        );
      }

      const response = (await conn.receive(this.timeout)) as ProgressResponse;

      if (!response) {
        throw new Error('No response received from service');
      }

      this.checkForError(response);

      // Report progress if available
      if (response.PercentComplete !== undefined && response.Status) {
        await progressCallback?.(response.PercentComplete, response.Status);
      }

      if (response.Status === 'Complete') {
        break;
      }
    }
  }

  private checkForError(response: ProgressResponse | BrowseResponse | LookupResponse): void {
    if (!response.Error) {
      return;
    }

    const error = response.Error;
    const description = response.ErrorDescription ?? 'No description';
    log.error(`Installation proxy error: ${error} - ${description}`);
    throw new Error(`${error}: ${description}`);
  }
}
