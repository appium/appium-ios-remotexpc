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
  InstallOptions,
  LookupOptions,
  LookupResponse,
  ProgressCallback,
  ProgressResponse,
} from './types.js';

const log = getLogger('InstallationProxyService');

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

    const applicationType = options.applicationType ?? 'Any';
    const returnAttributes =
      options.returnAttributes ?? DEFAULT_RETURN_ATTRIBUTES;

    const request: PlistDictionary = {
      Command: 'Browse',
      ClientOptions: {
        ApplicationType: applicationType,
        ReturnAttributes: returnAttributes,
      },
    };

    const conn = await this.getConnection();
    await conn.sendPlist(request);

    const result: AppInfo[] = [];

    while (true) {
      const response = (await conn.receive(this.timeout)) as BrowseResponse;

      this.checkForError(response);

      if (response.CurrentList && response.CurrentList.length > 0) {
        result.push(...response.CurrentList);
        log.debug(
          `Received ${util.pluralize('app', response.CurrentList.length, true)}, total: ${util.pluralize('app', result.length, true)}`,
        );
      }

      if (response.Status === 'Complete') {
        log.info(
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

    log.info(
      `Lookup found ${util.pluralize('application', Object.keys(response.LookupResult).length, true)}`,
    );
    return response.LookupResult;
  }

  /**
   * Get all installed applications with optional size calculation
   */
  async getApps(
    applicationType: ApplicationType = 'Any',
    calculateSizes: boolean = false,
    bundleIds?: string[],
  ): Promise<Record<string, AppInfo>> {
    log.debug('Get apps:', { applicationType, calculateSizes, bundleIds });

    const options: LookupOptions = {
      applicationType,
    };

    if (bundleIds && bundleIds.length > 0) {
      options.bundleIDs = bundleIds;
    }

    const result = await this.lookup(bundleIds, options);

    if (calculateSizes) {
      const sizeOptions: LookupOptions = {
        ...options,
        returnAttributes: SIZE_ATTRIBUTES,
      };
      const additionalInfo = await this.lookup(bundleIds, sizeOptions);

      for (const [bundleId, appInfo] of Object.entries(additionalInfo)) {
        if (result[bundleId]) {
          result[bundleId] = { ...result[bundleId], ...appInfo };
        }
      }
    }

    return result;
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
    log.info(`Installing app from: ${packagePath}`);

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
    options: Record<string, string | number | boolean> = {},
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    log.info(`Uninstalling app: ${bundleIdentifier}`);

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
    log.info(`Upgrading app from: ${packagePath}`);

    const request: PlistDictionary = {
      Command: 'Upgrade',
      PackagePath: packagePath,
      ClientOptions: options as PlistDictionary,
    };

    await this.executeWithProgress(request, progressCallback);
    log.info('Upgrade complete');
  }

  /**
   * Close the connection
   */
  close(): void {
    try {
      if (this.connection) {
        this.connection.close();
        this.connection = null;
        log.debug('Connection closed successfully');
      }
    } catch (error) {
      log.error('Error closing connection:', error);
      // Always set to null even if close fails
      this.connection = null;
    }
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
    await conn.sendPlist(request);

    while (true) {
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

        progressCallback?.(percent, status);
      }

      // Only break when we receive the final "Complete" status without progress info
      // Progress statuses like "InstallComplete" still have PercentComplete field
      if (
        response.Status === 'Complete' &&
        response.PercentComplete === undefined
      ) {
        log.debug('Operation complete');
        break;
      }
    }
  }

  private checkForError(
    response: ProgressResponse | BrowseResponse | LookupResponse,
  ): void {
    if (response.Error) {
      const error = response.Error;
      const description = response.ErrorDescription ?? 'No description';
      log.error(`Installation proxy error: ${error} - ${description}`);
      throw new Error(`${error}: ${description}`);
    }
  }
}
