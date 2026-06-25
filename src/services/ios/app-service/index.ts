import { createPlist } from '../../../lib/plist/index.js';
import type {
  PlistDictionary,
  XPCDictionary,
  XPCValue,
} from '../../../lib/types.js';
import {
  type CoreDeviceInvokeOptions,
  CoreDeviceService,
} from '../core-device/core-device-service.js';

const FEATURE_LIST_APPS = 'com.apple.coredevice.feature.listapps';
const FEATURE_LAUNCH_APPLICATION =
  'com.apple.coredevice.feature.launchapplication';
const FEATURE_LIST_PROCESSES = 'com.apple.coredevice.feature.listprocesses';
const FEATURE_UNINSTALL_APP = 'com.apple.coredevice.feature.uninstallapp';
const FEATURE_SEND_SIGNAL = 'com.apple.coredevice.feature.sendsignaltoprocess';
const FEATURE_MONITOR_PROCESS_TERMINATION =
  'com.apple.coredevice.feature.monitorprocesstermination';

/** A process as reported by the device (pid + executable location). */
export interface AppServiceProcessToken {
  processIdentifier: number;
  executableURL?: { relative?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * An installed application entry. Only the most commonly used fields are typed;
 * the device returns additional metadata accessible via the index signature.
 */
export interface InstalledApp {
  bundleIdentifier?: string;
  name?: string;
  version?: string;
  path?: string;
  isRemovable?: boolean;
  isInternal?: boolean;
  isHidden?: boolean;
  isAppClip?: boolean;
  isDefault?: boolean;
  [key: string]: unknown;
}

export interface ListAppsOptions {
  includeAppClips?: boolean;
  includeRemovableApps?: boolean;
  includeHiddenApps?: boolean;
  includeInternalApps?: boolean;
  includeDefaultApps?: boolean;
  /**
   * Restrict results to apps the caller has container access to. Required by
   * iOS 26+; defaults to false (list all apps).
   */
  requireContainerAccess?: boolean;
  /**
   * Include each app's app-group identifiers in the response. Required key on
   * iOS 26+; defaults to false.
   */
  includeAppGroupIdentifiers?: boolean;
  /**
   * Include each app's on-device container paths in the response. Required key
   * on iOS 26+; defaults to false.
   */
  includeContainerPaths?: boolean;
  /**
   * Override the default invocation timeout (ms). Recommended on iOS 26+, where
   * the device may not respond to a full app enumeration over this path.
   */
  timeoutMs?: number;
}

export interface LaunchApplicationOptions {
  /** Launch arguments passed to the application. */
  arguments?: string[];
  /** Environment variables to inject. */
  environment?: Record<string, string>;
  /** Start the process suspended (stopped) instead of running. */
  startSuspended?: boolean;
  /** Terminate an already-running instance before launching. Defaults to true. */
  terminateExisting?: boolean;
  /** Extra platform-specific options serialized into a plist. */
  platformSpecificOptions?: Record<string, unknown>;
  /** Override the default invocation timeout. */
  timeoutMs?: number;
}

/** Result of launching an application. */
export interface LaunchedApplication {
  /** The launched process token (pid + executable location). */
  processToken?: AppServiceProcessToken;
  /** Convenience accessor for the launched process id, when available. */
  processIdentifier?: number;
  [key: string]: unknown;
}

/**
 * CoreDevice AppService — manage applications and processes on the device.
 *
 * This is the modern (`devicectl`) backend for app lifecycle on iOS 17+: listing
 * installed apps, launching/terminating apps, enumerating processes, signaling
 * processes and uninstalling apps. Communicates over RemoteXPC via the shared
 * {@link CoreDeviceService} invocation envelope.
 *
 * @example
 * ```ts
 * import { constants as osConstants } from 'node:os';
 *
 * const appService = await Services.startAppService(udid);
 * try {
 *   const launched = await appService.launchApplication('com.apple.Preferences');
 *   await appService.sendSignalToProcess(
 *     launched.processIdentifier!,
 *     osConstants.signals.SIGKILL,
 *   );
 * } finally {
 *   await appService.close();
 * }
 * ```
 */
export class AppService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.appservice';

  constructor(udid: string) {
    super(udid, AppService.RSD_SERVICE_NAME);
  }

  /**
   * Lists installed applications. All categories are included by default.
   *
   * ⚠️ Limited on iOS 26+: the device gates app enumeration on this path and
   * does not respond for requests that would return apps whose data containers
   * the caller cannot access (the call hangs until `timeoutMs`). It only returns
   * for result sets needing no container access (typically empty). For reliable
   * app enumeration across iOS versions, prefer
   * {@link InstallationProxyService.browse} (`Services.startInstallationProxyService`).
   * This method remains for parity with the modern `devicectl`-style API and for
   * environments/devices where the privileged context is available.
   */
  async listApps(options: ListAppsOptions = {}): Promise<InstalledApp[]> {
    const output = await this.invoke(
      FEATURE_LIST_APPS,
      {
        includeAppClips: options.includeAppClips ?? true,
        includeRemovableApps: options.includeRemovableApps ?? true,
        includeHiddenApps: options.includeHiddenApps ?? true,
        includeInternalApps: options.includeInternalApps ?? true,
        includeDefaultApps: options.includeDefaultApps ?? true,
        requireContainerAccess: options.requireContainerAccess ?? false,
        includeAppGroupIdentifiers: options.includeAppGroupIdentifiers ?? false,
        includeContainerPaths: options.includeContainerPaths ?? false,
      },
      { timeoutMs: options.timeoutMs },
    );
    return asArray(output) as InstalledApp[];
  }

  /**
   * Launches an application by bundle identifier and returns its process token.
   *
   * Throws a {@link CoreDeviceError} if the bundle id is not installed (the
   * device reports e.g. "The requested application … is not installed.").
   */
  async launchApplication(
    bundleId: string,
    options: LaunchApplicationOptions = {},
  ): Promise<LaunchedApplication> {
    const platformOptions = createPlist(
      (options.platformSpecificOptions ?? {}) as PlistDictionary,
    );
    const platformOptionsBuffer = Buffer.isBuffer(platformOptions)
      ? platformOptions
      : Buffer.from(platformOptions, 'utf8');

    const output = asDict(
      await this.invoke(
        FEATURE_LAUNCH_APPLICATION,
        {
          applicationSpecifier: {
            bundleIdentifier: { _0: bundleId },
          },
          options: {
            arguments: options.arguments ?? [],
            environmentVariables: options.environment ?? {},
            standardIOUsesPseudoterminals: true,
            startStopped: options.startSuspended ?? false,
            terminateExisting: options.terminateExisting ?? true,
            user: { shortName: 'mobile' },
            platformSpecificOptions: platformOptionsBuffer,
          },
          standardIOIdentifiers: {},
        },
        { timeoutMs: options.timeoutMs },
      ),
    );

    return {
      ...output,
      processIdentifier: extractProcessIdentifier(output),
    };
  }

  /**
   * Lists the processes currently running on the device.
   */
  async listProcesses(): Promise<AppServiceProcessToken[]> {
    const output = asDict(await this.invoke(FEATURE_LIST_PROCESSES));
    return asArray(output.processTokens) as AppServiceProcessToken[];
  }

  /**
   * Sends a POSIX signal to a process by pid. Use `os.constants.signals` for
   * signal numbers (e.g. `SIGKILL` to terminate, `SIGTERM` to ask politely).
   *
   * Throws a {@link CoreDeviceError} if the pid is not running (the device
   * reports `com.apple.dt.CoreDeviceError`).
   */
  async sendSignalToProcess(
    pid: number,
    signal: number,
  ): Promise<XPCDictionary> {
    return asDict(
      await this.invoke(FEATURE_SEND_SIGNAL, {
        process: { processIdentifier: pid },
        signal,
      }),
    );
  }

  /**
   * Uninstalls an application by bundle identifier. This is idempotent: the
   * device resolves successfully even if the app is not installed.
   */
  async uninstallApp(bundleId: string): Promise<void> {
    await this.invoke(FEATURE_UNINSTALL_APP, { bundleIdentifier: bundleId });
  }

  /**
   * Monitors termination of a process and resolves with its exit status
   * (`{ status: { exitCode, wasCoreDumpCreated } }`). If the pid is not running,
   * the device resolves immediately rather than waiting. Pass `timeoutMs` via
   * `options` to bound how long to wait for a still-running process to exit.
   */
  async monitorProcessTermination(
    pid: number,
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCDictionary> {
    return asDict(
      await this.invoke(
        FEATURE_MONITOR_PROCESS_TERMINATION,
        { processToken: { processIdentifier: pid } },
        options,
      ),
    );
  }
}

function asDict(value: XPCValue): XPCDictionary {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as XPCDictionary;
  }
  return {};
}

function asArray(value: XPCValue): XPCValue[] {
  return Array.isArray(value) ? value : [];
}

function extractProcessIdentifier(output: XPCDictionary): number | undefined {
  const token = output.processToken;
  if (token && typeof token === 'object' && !Array.isArray(token)) {
    const pid = (token as XPCDictionary).processIdentifier;
    if (typeof pid === 'number') {
      return pid;
    }
  }
  return undefined;
}

export default AppService;
