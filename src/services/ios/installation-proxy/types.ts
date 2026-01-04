export type ApplicationType = 'Any' | 'User' | 'System';

export type ProgressCallback = (
  percentComplete: number,
  status: string,
) => void;

export interface BrowseOptions {
  applicationType?: ApplicationType;
  returnAttributes?: string[];
}

export interface InstallOptions {
  packageType?: string;
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
