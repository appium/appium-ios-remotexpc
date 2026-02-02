export type ApplicationType = 'Any' | 'User' | 'System';

export type ProgressCallback = (
  percentComplete: number,
  status: string,
) => void | Promise<void>;

export interface BrowseOptions {
  applicationType?: ApplicationType;
  /**
   * Array of attribute names to return.
   * Use ['*'] to get all available attributes.
   */
  returnAttributes?: string[] | '*';
}

export interface InstallOptions {
  packageType?: string;
  timeoutMs?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface UninstallOptions {
  timeoutMs?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface LookupOptions {
  bundleIDs?: string[];
  returnAttributes?: string[];
  applicationType?: ApplicationType;
}

export interface AppInfo {
  CFBundleIdentifier?: string;
  CFBundleName?: string;
  CFBundleDisplayName?: string;
  CFBundleVersion?: string;
  CFBundleShortVersionString?: string;
  ApplicationType?: string;
  Path?: string;
  Container?: string;
  StaticDiskUsage?: number;
  DynamicDiskUsage?: number;
}

export interface ProgressResponse {
  PercentComplete?: number;
  Status?: string;
  Error?: string;
  ErrorDescription?: string;
}

export interface BrowseResponse {
  CurrentList?: AppInfo[];
  Status?: string;
  Error?: string;
  ErrorDescription?: string;
}

export interface LookupResponse {
  LookupResult?: Record<string, AppInfo>;
  Status?: string;
  Error?: string;
  ErrorDescription?: string;
}

/**
 * Action taken during an install/upgrade operation
 */
export type InstallAction = 'installed' | 'upgraded' | 'skipped';

/**
 * Result of an install/upgrade operation
 */
export interface InstallOperationResult {
  action: InstallAction;
  reason: string;
  currentVersion?: string;
  targetVersion: string;
}
