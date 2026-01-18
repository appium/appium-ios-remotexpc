import { util } from '@appium/support';

import { getLogger } from '../../../lib/logger.js';
import type { PlistDictionary } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';
import type {
  AppInfo,
  ApplicationType,
  BrowseOptions,
  BrowseResponse,
  InstallAction,
  InstallOperationResult,
  InstallOptions,
  LookupOptions,
  LookupResponse,
  ProgressCallback,
  ProgressResponse,
  UninstallOptions,
} from './types.js';

/**
 * Context object to bundle install/upgrade operation parameters
 */
interface InstallContext {
  bundleIdentifier: string;
  packagePath: string;
  targetVersion: string;
  installOptions: InstallOptions;
  progressCallback?: ProgressCallback;
  currentVersion?: string;
}

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

export const SIZE_ATTRIBUTES = [
  'CFBundleIdentifier',
  'StaticDiskUsage',
  'DynamicDiskUsage',
];

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
 * Constants for install/upgrade operation messages
 */
const INSTALL_MESSAGES = {
  FRESH_INSTALL: 'App was not previously installed',
  VERSION_UNKNOWN: 'Current version could not be determined',
  DOWNGRADE_NOT_SUPPORTED:
    'Downgrades are not supported by iOS installation_proxy',
  SAME_VERSION_NOT_SUPPORTED:
    'Reinstalling the same version is not supported by iOS installation_proxy',
} as const;

/**
 * InstallationProxyService provides an API to manage app installation and queries
 */
export class InstallationProxyService extends BaseService {
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.installation_proxy.shim.remote';
  private readonly timeout: number;
  private connection: ServiceConnection | null = null;

  constructor(address: [string, number], timeout: number = 30000) {
    super(address);
    this.timeout = timeout;
  }

  /**
   * Browse installed applications
   */
  async browse(options: BrowseOptions = {}): Promise<AppInfo[]> {
    log.debug('Browse command with options:', options);

    const {
      applicationType = DEFAULT_APPLICATION_TYPE,
      returnAttributes = DEFAULT_RETURN_ATTRIBUTES,
    } = options;

    const request: PlistDictionary = {
      Command: 'Browse',
      ClientOptions: {
        ApplicationType: applicationType,
        ReturnAttributes: returnAttributes,
      },
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
        log.debug(
          `Received ${util.pluralize('app', response.CurrentList.length, true)}, total: ${util.pluralize('app', result.length, true)}`,
        );
      }

      if (response.Status === 'Complete') {
        log.debug(
          `Browse complete. Found ${util.pluralize('application', result.length, true)}.`,
        );
        break;
      }
    }

    return result;
  }

  /**
   * Lookup application information by bundle IDs
   */
  async lookup(
    bundleIds?: string[],
    options: Partial<LookupOptions> = {},
  ): Promise<Record<string, AppInfo>> {
    log.debug('Lookup command for bundle IDs:', bundleIds);

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
    const response = (await conn.sendPlistRequest(
      request,
      this.timeout,
    )) as LookupResponse;

    this.checkForError(response);

    if (!response.LookupResult) {
      log.warn('Lookup returned no results');
      return {};
    }

    log.debug(
      `Lookup found ${util.pluralize('application', Object.keys(response.LookupResult).length, true)}`,
    );
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
    log.debug('Get apps:', { applicationType, calculateSizes, bundleIds });

    const options: LookupOptions = {
      applicationType,
    };

    if (calculateSizes) {
      // Combine default attributes with size attributes in a single call
      options.returnAttributes = [
        ...DEFAULT_RETURN_ATTRIBUTES,
        'StaticDiskUsage',
        'DynamicDiskUsage',
      ];
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
  async install(
    packagePath: string,
    options: InstallOptions = {},
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    log.debug(`Installing app from: ${packagePath}`);

    const request: PlistDictionary = {
      Command: 'Install',
      PackagePath: packagePath,
      ClientOptions: options as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback);
    log.info('Installation complete');
  }

  /**
   * Uninstall an application by bundle identifier
   */
  async uninstall(
    bundleIdentifier: string,
    options: UninstallOptions = {},
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    log.debug(`Uninstalling app: ${bundleIdentifier}`);

    const request: PlistDictionary = {
      Command: 'Uninstall',
      ApplicationIdentifier: bundleIdentifier,
      ClientOptions: options,
    };

    await this.executeWithProgress(request, progressCallback);
    log.info('Uninstallation complete');
  }

  /**
   * Upgrade an existing application
   * @param packagePath Path to the IPA file on the device (e.g., '/PublicStaging/app.ipa')
   * @param options Installation options
   * @param progressCallback Optional callback for progress updates
   */
  async upgrade(
    packagePath: string,
    options: InstallOptions = {},
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    log.debug(`Upgrading app from: ${packagePath}`);

    const request: PlistDictionary = {
      Command: 'Upgrade',
      PackagePath: packagePath,
      ClientOptions: options as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback);
    log.info('Upgrade complete');
  }

  /**
   * Smart install or upgrade that checks version before proceeding
   * @param bundleIdentifier Bundle ID of the app to install/upgrade
   * @param packagePath Path to the IPA file on the device (e.g., '/PublicStaging/app.ipa')
   * @param targetVersion The version string of the new IPA (e.g., '1.2.3')
   * @param options Installation options
   * @param progressCallback Optional callback for progress updates
   * @returns Object indicating what action was taken and why
   */
  async installOrUpgradeApp(
    bundleIdentifier: string,
    packagePath: string,
    targetVersion: string,
    options: InstallOptions = {},
    progressCallback?: ProgressCallback,
  ): Promise<InstallOperationResult> {
    log.debug(
      `Checking installation status for ${bundleIdentifier} (target version: ${targetVersion})`,
    );

    const installStatus = await this.isAppInstalled(bundleIdentifier);
    const currentVersion = installStatus.version;

    const ctx: InstallContext = {
      bundleIdentifier,
      packagePath,
      targetVersion,
      installOptions: options,
      progressCallback,
      currentVersion,
    };

    if (!installStatus.isInstalled) {
      return this.handleFreshInstall(ctx);
    }

    if (!currentVersion) {
      return this.handleUnknownVersion(ctx);
    }

    log.debug(
      `Current version: ${currentVersion}, Target version: ${targetVersion}`,
    );

    const comparison = this.compareVersions(currentVersion, targetVersion);

    if (comparison < 0) {
      return this.handleUpgrade(ctx);
    }
    if (comparison > 0) {
      return this.handleDowngrade(ctx);
    }
    return this.handleSameVersion(ctx);
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
    log.debug(`Checking if app ${bundleIdentifier} is installed`);

    try {
      const installedApps = await this.lookup([bundleIdentifier]);
      const appInfo = installedApps[bundleIdentifier];

      if (!appInfo) {
        log.debug(`App ${bundleIdentifier} is not installed`);
        return { isInstalled: false };
      }

      const version =
        appInfo.CFBundleShortVersionString || appInfo.CFBundleVersion;

      log.debug(
        `App ${bundleIdentifier} is installed${version ? ` (version: ${version})` : ''}`,
      );

      return {
        isInstalled: true,
        version,
        appInfo,
      };
    } catch (error) {
      log.error(`Error checking if app is installed: ${error}`);
      // If lookup fails, assume app is not installed
      return { isInstalled: false };
    }
  }

  /**
   * Close the connection
   */
  close(): void {
    try {
      if (this.connection) {
        this.connection.close();
        log.debug('Connection closed successfully');
      }
    } catch (error) {
      log.error('Error closing connection:', error);
    } finally {
      // Always set to null even if close fails
      this.connection = null;
    }
  }

  /**
   * Handle fresh installation when app is not installed
   */
  private async handleFreshInstall(
    ctx: InstallContext,
  ): Promise<InstallOperationResult> {
    log.debug(
      `App ${ctx.bundleIdentifier} is not installed. Performing fresh install.`,
    );
    await this.install(
      ctx.packagePath,
      ctx.installOptions,
      ctx.progressCallback,
    );
    return this.createResult(
      'installed',
      INSTALL_MESSAGES.FRESH_INSTALL,
      ctx.targetVersion,
    );
  }

  /**
   * Handle installation when current version cannot be determined
   */
  private async handleUnknownVersion(
    ctx: InstallContext,
  ): Promise<InstallOperationResult> {
    log.warn(
      `Could not determine current version for ${ctx.bundleIdentifier}. Proceeding with upgrade.`,
    );
    await this.upgrade(
      ctx.packagePath,
      ctx.installOptions,
      ctx.progressCallback,
    );
    return this.createResult(
      'upgraded',
      INSTALL_MESSAGES.VERSION_UNKNOWN,
      ctx.targetVersion,
      'unknown',
    );
  }

  /**
   * Handle upgrade to newer version
   */
  private async handleUpgrade(
    ctx: InstallContext,
  ): Promise<InstallOperationResult> {
    const { currentVersion, targetVersion } = ctx;
    log.debug(
      `Current version ${currentVersion} is older than ${targetVersion}. Upgrading.`,
    );
    await this.upgrade(
      ctx.packagePath,
      ctx.installOptions,
      ctx.progressCallback,
    );
    return this.createResult(
      'upgraded',
      `Upgraded from ${currentVersion} to ${targetVersion}`,
      targetVersion,
      currentVersion,
    );
  }

  /**
   * Handle downgrade attempt
   */
  private async handleDowngrade(
    ctx: InstallContext,
  ): Promise<InstallOperationResult> {
    const { currentVersion, targetVersion } = ctx;

    log.warn(
      `Current version ${currentVersion} is newer than target ${targetVersion}. Downgrades are not supported by iOS.`,
    );
    return this.createResult(
      'skipped',
      `Current version ${currentVersion} is newer than target ${targetVersion}. ${INSTALL_MESSAGES.DOWNGRADE_NOT_SUPPORTED}`,
      targetVersion,
      currentVersion,
    );
  }

  /**
   * Handle reinstall of same version
   */
  private async handleSameVersion(
    ctx: InstallContext,
  ): Promise<InstallOperationResult> {
    const { currentVersion, targetVersion } = ctx;

    log.debug(
      `App is already at version ${targetVersion}. Skipping reinstall.`,
    );
    return this.createResult(
      'skipped',
      `App is already at version ${targetVersion}. ${INSTALL_MESSAGES.SAME_VERSION_NOT_SUPPORTED}`,
      targetVersion,
      currentVersion,
    );
  }

  /**
   * Create standardized result object
   */
  private createResult(
    action: InstallAction,
    reason: string,
    targetVersion: string,
    currentVersion?: string,
  ): InstallOperationResult {
    return {
      action,
      reason,
      targetVersion,
      ...(currentVersion && { currentVersion }),
    };
  }

  /**
   * Compare two version strings
   * @param version1 First version string (e.g., '1.2.3')
   * @param version2 Second version string (e.g., '1.2.4')
   * @returns -1 if version1 < version2, 0 if equal, 1 if version1 > version2
   */
  private compareVersions(version1: string, version2: string): number {
    // Handle build numbers like "1.2.3 (123)" by extracting just the version part
    const cleanVersion1 = version1.split(/[\s(]/)[0];
    const cleanVersion2 = version2.split(/[\s(]/)[0];

    const parts1 = cleanVersion1.split('.').map((p) => parseInt(p, 10) || 0);
    const parts2 = cleanVersion2.split('.').map((p) => parseInt(p, 10) || 0);

    // Pad arrays to same length
    const maxLength = Math.max(parts1.length, parts2.length);
    while (parts1.length < maxLength) {
      parts1.push(0);
    }
    while (parts2.length < maxLength) {
      parts2.push(0);
    }

    // Compare each part
    for (let i = 0; i < maxLength; i++) {
      if (parts1[i] < parts2[i]) {
        return -1;
      }
      if (parts1[i] > parts2[i]) {
        return 1;
      }
    }

    return 0; // Versions are equal
  }

  private async getConnection(): Promise<ServiceConnection> {
    if (this.connection) {
      return this.connection;
    }

    const service = {
      serviceName: InstallationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    this.connection = await this.startLockdownService(service, {
      createConnectionTimeout: this.timeout,
    });

    const startServiceResponse = await this.connection.receive(this.timeout);
    log.debug('StartService response:', startServiceResponse);

    if (!startServiceResponse) {
      throw new Error('No response received from service');
    }

    if (startServiceResponse.Request !== 'StartService') {
      throw new Error(
        `Expected StartService response, got: ${JSON.stringify(startServiceResponse)}`,
      );
    }

    if (startServiceResponse.Error) {
      const errorDesc =
        startServiceResponse.ErrorDescription ?? 'Unknown error';
      throw new Error(
        `Service start failed: ${startServiceResponse.Error} - ${errorDesc}`,
      );
    }

    return this.connection;
  }

  private async executeWithProgress(
    request: PlistDictionary,
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    const conn = await this.getConnection();
    conn.sendPlist(request);

    const startTime = performance.now();

    while (true) {
      if (performance.now() - startTime > MAX_INSTALL_DURATION_MS) {
        throw new Error(
          `Operation exceeded maximum duration (${MAX_INSTALL_DURATION_MS / 1000}s). ` +
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
        const percent = response.PercentComplete;
        const status = response.Status;
        log.debug(`Progress: ${percent}% - ${status}`);

        await progressCallback?.(percent, status);
      }

      // Break when we receive the final "Complete" status
      if (response.Status === 'Complete') {
        log.debug('Operation complete');
        break;
      }
    }
  }

  private checkForError(
    response: ProgressResponse | BrowseResponse | LookupResponse,
  ): void {
    if (!response.Error) {
      return;
    }

    const error = response.Error;
    const description = response.ErrorDescription ?? 'No description';
    log.error(`Installation proxy error: ${error} - ${description}`);
    throw new Error(`${error}: ${description}`);
  }
}
