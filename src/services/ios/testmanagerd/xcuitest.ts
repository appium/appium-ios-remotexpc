import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { getLogger } from '../../../lib/logger.js';
import { createBinaryPlist } from '../../../lib/plist/index.js';
import type {
  TestmanagerdService,
  XCTestServices,
} from '../../../lib/types.js';
import * as Services from '../../../services.js';
import { MessageAux } from '../dvt/dtx-message.js';
import { DVTSecureSocketProxyService } from '../dvt/index.js';
import { ProcessControl } from '../dvt/instruments/process-control.js';
import { InstallationProxyService } from '../installation-proxy/index.js';
import { DvtTestmanagedProxyService } from './index.js';
import {
  XCTestConfigurationEncoder,
  type XCTestConfigurationParams,
} from './xctestconfiguration.js';

const log = getLogger('XCUITestService');

/** Default Xcode protocol version */
const XCODE_VERSION = 36;

/** Testmanagerd channel identifier for XCTest session management */
export const TESTMANAGERD_CHANNEL =
  'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface';

/** Default XCTCapabilities sent to the exec session. */
export const DEFAULT_EXEC_CAPABILITIES: Record<string, number> = {
  'XCTIssue capability': 1,
  'daemon container sandbox extension': 1,
  'delayed attachment transfer': 1,
  'expected failure test capability': 1,
  'request diagnostics for specific devices': 1,
  'skipped test capability': 1,
  'test case run configurations': 1,
  'test iterations': 1,
  'test timeout capability': 1,
  'ubiquitous test identifiers': 1,
};

/**
 * Options for configuring an XCUITest session
 */
export interface XCUITestOptions {
  /** Device UDID */
  udid: string;
  /** Bundle ID of the XCTest runner app */
  xctestBundleId: string;
  /** Bundle ID of the app under test */
  targetBundleId?: string;
  /** Environment variables to pass to the test process */
  env?: Record<string, string>;
  /** Arguments to pass to the test process */
  args?: string[];
  /** Xcode protocol version (default: 36) */
  xcodeVersion?: number;
  /** Full path to app under test on device */
  targetAppPath?: string;
  /** Product module name for XCTestConfiguration */
  productModuleName?: string;
}

/** High-level XCTest runner options */
export interface XCTestRunnerOptions {
  /** Device UDID */
  udid: string;
  /** Bundle ID of test runner app (.xctrunner) */
  testRunnerBundleId: string;
  /** Bundle ID of app under test */
  appUnderTestBundleId: string;
  /** Bundle ID of xctest bundle (without .xctrunner) */
  xctestBundleId: string;
  /** Max wait for plan completion in ms (default: 180000) */
  timeoutMs?: number;
  /** Polling interval in ms (default: 500) */
  pollIntervalMs?: number;
  /** Xcode protocol version */
  xcodeVersion?: number;
  /** Extra launch environment variables */
  launchEnvironment?: Record<string, string>;
  /** Launch arguments */
  launchArguments?: string[];
  /** Kill existing runner process before launch (default: true) */
  killExisting?: boolean;
}

/** Result returned by high-level XCTest run */
export interface XCTestRunResult {
  status: 'passed' | 'timed_out';
  sessionIdentifier: string;
  testRunnerPid: number;
  durationMs: number;
}

/**
 * XCUITestService orchestrates the full XCTest launch lifecycle
 * using the iOS 17+ testmanagerd capabilities-based protocol.
 *
 * It coordinates testmanagerd (control + exec connections) to run
 * XCTest sessions without xcodebuild.
 *
 * Flow (iOS 17+):
 * 1. Init exec session with capabilities
 * 2. (Caller launches test app externally)
 * 3. Start background listener on exec channel
 * 4. Init control session with capabilities
 * 5. Authorize test session with PID
 * 6. Start test plan execution
 * 7. Listen for test callbacks
 *
 * Usage:
 * ```typescript
 * const xcuitest = new XCUITestService({
 *   controlConnection: controlTestmanagerd,
 *   execConnection: execTestmanagerd,
 *   options: { udid, xctestBundleId: 'com.example.Runner.xctrunner' },
 * });
 * await xcuitest.initExecSession();
 * // ... launch test app externally via ProcessControl ...
 * xcuitest.startExecCallbackListener(testBundlePath);
 * await xcuitest.initControlSessionAndAuthorize(pid);
 * await xcuitest.startExecutingTestPlan();
 * // ... wait for completion or poll xcuitest.getIsRunning() ...
 * await xcuitest.stop();
 * ```
 */
export class XCUITestService {
  private readonly controlConnection: TestmanagerdService;
  private readonly execConnection: TestmanagerdService;
  private readonly options: XCUITestOptions;
  private readonly xcodeVersion: number;

  private controlChannelCode: number = 0;
  private execChannelCode: number = 0;
  private testProcessPid: number = 0;
  private sessionIdentifier: string;
  private isRunning: boolean = false;
  private configPayload: Buffer | null = null;
  private callbackListenerPromise: Promise<void> | null = null;
  private listenerAbortController: AbortController | null = null;
  private lastListenerError: Error | null = null;
  private configReplySentResolve: (() => void) | null = null;
  private configReplySentPromise: Promise<void> | null = null;

  constructor(config: {
    controlConnection: TestmanagerdService;
    execConnection: TestmanagerdService;
    options: XCUITestOptions;
  }) {
    this.controlConnection = config.controlConnection;
    this.execConnection = config.execConnection;
    this.options = config.options;
    this.xcodeVersion = config.options.xcodeVersion ?? XCODE_VERSION;
    this.sessionIdentifier = crypto.randomUUID();
  }

  /**
   * Initialize the exec session with capabilities.
   * This must be called first, before launching the test app.
   */
  async initExecSession(): Promise<void> {
    log.info('Initializing exec session...');

    const execChannel =
      await this.execConnection.makeChannel(TESTMANAGERD_CHANNEL);
    this.execChannelCode = execChannel.getCode();

    const args = new MessageAux();
    args.appendObj({ __type: 'NSUUID', uuid: this.sessionIdentifier });
    args.appendObj({
      __type: 'XCTCapabilities',
      capabilities: DEFAULT_EXEC_CAPABILITIES,
    });

    await this.execConnection.sendMessage(
      this.execChannelCode,
      '_IDE_initiateSessionWithIdentifier:capabilities:',
      args,
    );

    const [result] = await this.execConnection.recvPlist(this.execChannelCode);
    log.debug('Exec session initiated:', result);
  }

  /**
   * Start a background listener on the exec channel.
   * Handles `_XCT_testRunnerReadyWithCapabilities:` by sending the
   * XCTestConfiguration reply. Must be called after launching the test app
   * but before `initControlSessionAndAuthorize`.
   *
   * The listener uses `recvPlistWithTimeout` to poll for messages,
   * and can be immediately canceled via `stop()`.
   *
   * @param testBundlePath Path to the test bundle on device
   */
  startExecCallbackListener(testBundlePath: string): void {
    if (this.callbackListenerPromise) {
      log.debug(
        'Exec callback listener already running. Restarting with fresh configuration.',
      );
      this.listenerAbortController?.abort();
      this.callbackListenerPromise.catch(() => {});
      this.callbackListenerPromise = null;
      this.listenerAbortController = null;
    }

    this.configPayload = this.createXCTestConfiguration(testBundlePath);
    this.lastListenerError = null;
    this.configReplySentPromise = new Promise<void>((resolve) => {
      this.configReplySentResolve = resolve;
    });
    this.listenerAbortController = new AbortController();
    const { signal } = this.listenerAbortController;

    const listenerPromise: Promise<void> = (async () => {
      while (!signal.aborted) {
        try {
          const result = await this.execConnection.recvPlistWithTimeout(
            this.execChannelCode,
            2000,
          );

          if (!result) {
            continue; // Timeout — poll again
          }

          const [selector, auxiliaries] = result;
          this.handleCallback(selector, auxiliaries);

          if (
            selector === '_XCT_testRunnerReadyWithCapabilities:' &&
            this.configPayload
          ) {
            log.info(
              'Test runner ready. Sending XCTestConfiguration response...',
            );
            await this.execConnection.sendReply(
              this.execChannelCode,
              this.configPayload,
            );
            log.info('XCTestConfiguration response sent');
            this.configReplySentResolve?.();
          }

          if (
            typeof selector === 'string' &&
            selector.startsWith('_XCT_didFinishExecutingTestPlan')
          ) {
            this.isRunning = false;
            break;
          }
        } catch (err: any) {
          if (signal.aborted) {
            break;
          }
          this.lastListenerError =
            err instanceof Error ? err : new Error(String(err));
          this.isRunning = false;
          log.debug(`Exec listener error: ${this.lastListenerError.message}`);
          break;
        }
      }
    })().finally(() => {
      if (this.callbackListenerPromise === listenerPromise) {
        this.callbackListenerPromise = null;
      }
      if (this.listenerAbortController?.signal === signal) {
        this.listenerAbortController = null;
      }
    });
    this.callbackListenerPromise = listenerPromise;
  }

  /**
   * Initialize the control session and authorize the test process.
   * Call this after launching the test app and starting the exec listener.
   *
   * @param pid The process identifier of the launched test runner
   */
  async initControlSessionAndAuthorize(pid: number): Promise<void> {
    this.testProcessPid = pid;

    // Init control session with capabilities
    const controlChannel =
      await this.controlConnection.makeChannel(TESTMANAGERD_CHANNEL);
    this.controlChannelCode = controlChannel.getCode();

    log.debug('Initiating control session with capabilities...');

    const controlArgs = new MessageAux();
    controlArgs.appendObj({
      __type: 'XCTCapabilities',
      capabilities: {},
    });

    await this.controlConnection.sendMessage(
      this.controlChannelCode,
      '_IDE_initiateControlSessionWithCapabilities:',
      controlArgs,
    );

    const [controlResult] = await this.controlConnection.recvPlist(
      this.controlChannelCode,
    );
    log.debug('Control session initiated:', controlResult);

    // Authorize test session
    log.debug(`Authorizing test session for PID ${pid}`);

    const authArgs = new MessageAux();
    authArgs.appendObj(pid);

    await this.controlConnection.sendMessage(
      this.controlChannelCode,
      '_IDE_authorizeTestSessionWithProcessID:',
      authArgs,
    );

    const [authResult] = await this.controlConnection.recvPlist(
      this.controlChannelCode,
    );
    log.debug('Authorization result:', authResult);
  }

  /**
   * Start executing the test plan.
   * Waits for the XCTestConfiguration reply to be sent before proceeding,
   * since the device ignores the test plan start if the config hasn't been
   * delivered yet.
   * Uses magic channel -1 (0xFFFFFFFF as signed int32).
   */
  async startExecutingTestPlan(): Promise<void> {
    if (this.configReplySentPromise) {
      log.debug(
        'Waiting for XCTestConfiguration reply before starting test plan...',
      );
      await this.configReplySentPromise;
    }

    log.debug('Starting test plan execution...');

    const args = new MessageAux();
    args.appendObj(this.xcodeVersion);

    // Magic channel -1 for test plan execution
    await this.execConnection.sendMessage(
      -1,
      '_IDE_startExecutingTestPlanWithProtocolVersion:',
      args,
      false,
    );

    this.isRunning = true;
    log.info('Test plan execution started');
  }

  /**
   * Stop the XCUITest session.
   * Immediately aborts the background listener and closes both
   * testmanagerd connections.
   */
  async stop(): Promise<void> {
    log.info('Stopping XCUITest session...');

    this.isRunning = false;

    // Resolve config promise so startExecutingTestPlan won't hang
    this.configReplySentResolve?.();
    this.configReplySentPromise = null;
    this.configReplySentResolve = null;

    // Immediately abort the background listener
    this.listenerAbortController?.abort();

    if (this.callbackListenerPromise) {
      try {
        await this.callbackListenerPromise;
      } catch {}
      this.callbackListenerPromise = null;
    }
    this.listenerAbortController = null;

    try {
      await this.controlConnection.close();
    } catch (error) {
      log.debug('Error closing control connection:', error);
    }

    try {
      await this.execConnection.close();
    } catch (error) {
      log.debug('Error closing exec connection:', error);
    }

    log.info('XCUITest session stopped');
  }

  /**
   * Get the session identifier
   */
  getSessionIdentifier(): string {
    return this.sessionIdentifier;
  }

  /**
   * Get the test process PID
   */
  getTestProcessPid(): number {
    return this.testProcessPid;
  }

  /**
   * Whether the session is currently running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  getLastListenerError(): Error | null {
    return this.lastListenerError;
  }

  /**
   * Get the exec channel code (for external listeners that need
   * direct access to the exec connection after `stop()` is NOT being
   * called — do not use concurrently with the background listener)
   */
  getExecChannelCode(): number {
    return this.execChannelCode;
  }

  /**
   * Get the exec connection (for external listeners that need
   * direct access — do not use concurrently with the background listener)
   */
  getExecConnection(): TestmanagerdService {
    return this.execConnection;
  }

  /**
   * Create an XCTestConfiguration plist buffer for writing to the device.
   *
   * @param testBundlePath Path to the test bundle on device
   * @returns Buffer containing the encoded XCTestConfiguration plist
   */
  createXCTestConfiguration(testBundlePath: string): Buffer {
    const encoder = new XCTestConfigurationEncoder();
    const params: XCTestConfigurationParams = {
      testBundleURL: `file://${testBundlePath}`,
      sessionIdentifier: this.sessionIdentifier,
      targetApplicationBundleID: this.options.targetBundleId,
      targetApplicationPath: this.options.targetAppPath,
      initializeForUITesting: true,
      reportResultsToIDE: true,
      productModuleName: this.options.productModuleName,
    };

    const archived = encoder.encodeXCTestConfiguration(params);
    return createBinaryPlist(archived);
  }

  private handleCallback(selector: any, auxiliaries: any[]): void {
    if (typeof selector !== 'string') {
      return;
    }

    switch (selector) {
      case '_XCT_logDebugMessage:':
        if (auxiliaries.length > 0) {
          const msg =
            typeof auxiliaries[0] === 'string'
              ? auxiliaries[0]
              : JSON.stringify(auxiliaries[0]);
          log.debug(`[XCTest] ${msg}`);
        }
        break;

      case '_XCT_testRunnerReadyWithCapabilities:':
        log.debug('Test runner ready with capabilities');
        break;

      case '_XCT_testBundleReadyWithProtocolVersion:minimumVersion:':
        log.debug(
          `Test bundle ready. Protocol: ${auxiliaries[0]}, Min: ${auxiliaries[1]}`,
        );
        break;

      case '_XCT_testCaseDidStartWithIdentifier:testCaseRunConfiguration:':
        log.debug(`Test case started: ${auxiliaries[0]}`);
        break;

      case '_XCT_testCaseWithIdentifier:didFinishWithStatus:duration:':
        log.debug(
          `Test case finished: ${auxiliaries[0]} - status: ${auxiliaries[1]} (${auxiliaries[2]}s)`,
        );
        break;

      case '_XCT_testSuiteWithIdentifier:didStartAt:':
        log.debug(`Test suite started: ${auxiliaries[0]}`);
        break;

      case '_XCT_testSuiteWithIdentifier:didFinishAt:runCount:skipCount:failureCount:expectedFailureCount:uncaughtExceptionCount:testDuration:totalDuration:':
        log.debug(
          `Test suite finished: ${auxiliaries[0]} - run: ${auxiliaries[2]}, skip: ${auxiliaries[3]}, fail: ${auxiliaries[4]}`,
        );
        break;

      case '_XCT_didFinishExecutingTestPlan':
        log.info('Test plan execution finished');
        this.isRunning = false;
        break;

      default:
        log.debug(`Callback: ${selector}`);
        break;
    }
  }
}

function getXctestNameFromBundleId(xctestBundleId: string): string {
  return xctestBundleId.split('.').at(-1) || xctestBundleId;
}

type InstalledAppInfo = {
  Path?: string;
  CFBundleExecutable?: string;
};

/**
 * High-level XCTest runner that manages service setup, launch, execution, and cleanup.
 */
export class XCTestRunner extends EventEmitter {
  private readonly options: XCTestRunnerOptions;
  private services: XCTestServices | null = null;
  private xcuitest: XCUITestService | null = null;
  private launchedPid: number = 0;

  constructor(options: XCTestRunnerOptions) {
    super();
    this.options = options;
  }

  async run(): Promise<XCTestRunResult> {
    const timeoutMs = this.options.timeoutMs ?? 180000;
    const pollIntervalMs = this.options.pollIntervalMs ?? 500;
    const startTime = Date.now();

    try {
      this.emit('step', 'start_services');
      const { remoteXPC, tunnelConnection } =
        await Services.createRemoteXPCConnection(this.options.udid);
      const host = tunnelConnection.host;

      let testmanagerdPort: number;
      let dvtPort: number;
      let installationProxyPort: number;
      try {
        testmanagerdPort = parseInt(
          remoteXPC.findService(DvtTestmanagedProxyService.RSD_SERVICE_NAME)
            .port,
          10,
        );
        dvtPort = parseInt(
          remoteXPC.findService(DVTSecureSocketProxyService.RSD_SERVICE_NAME)
            .port,
          10,
        );
        installationProxyPort = parseInt(
          remoteXPC.findService(InstallationProxyService.RSD_SERVICE_NAME).port,
          10,
        );
      } finally {
        await remoteXPC.close().catch(() => {});
      }

      const execTestmanagerd = new DvtTestmanagedProxyService([
        host,
        testmanagerdPort,
      ]);
      await execTestmanagerd.connect();
      const controlTestmanagerd = new DvtTestmanagedProxyService([
        host,
        testmanagerdPort,
      ]);
      await controlTestmanagerd.connect();
      const dvtService = new DVTSecureSocketProxyService([host, dvtPort]);
      await dvtService.connect();
      const processControl = new ProcessControl(dvtService);

      this.services = {
        execTestmanagerd,
        controlTestmanagerd,
        dvtService,
        processControl,
      };
      const installationProxyService = new InstallationProxyService([
        host,
        installationProxyPort,
      ]);

      this.emit('step', 'lookup_apps');
      const appLookup = await installationProxyService.lookup(
        [this.options.testRunnerBundleId, this.options.appUnderTestBundleId],
        { returnAttributes: ['Path', 'CFBundleExecutable'] },
      );
      installationProxyService.close();

      const runnerApp = appLookup[this.options.testRunnerBundleId] as
        | InstalledAppInfo
        | undefined;
      if (!runnerApp?.Path) {
        throw new Error(
          `Runner app not found: ${this.options.testRunnerBundleId}`,
        );
      }

      const targetApp = appLookup[this.options.appUnderTestBundleId] as
        | InstalledAppInfo
        | undefined;
      if (!targetApp?.Path) {
        throw new Error(
          `Target app not found: ${this.options.appUnderTestBundleId}`,
        );
      }

      const xctestName = getXctestNameFromBundleId(this.options.xctestBundleId);
      const runnerPath = runnerApp.Path;
      const targetPath = targetApp.Path;
      const testBundlePath = `${runnerPath}/PlugIns/${xctestName}.xctest`;

      this.xcuitest = new XCUITestService({
        controlConnection: this.services.controlTestmanagerd,
        execConnection: this.services.execTestmanagerd,
        options: {
          udid: this.options.udid,
          xctestBundleId: this.options.testRunnerBundleId,
          targetBundleId: this.options.appUnderTestBundleId,
          targetAppPath: targetPath,
          productModuleName: xctestName,
          xcodeVersion: this.options.xcodeVersion,
        },
      });

      const sessionId = this.xcuitest.getSessionIdentifier();

      this.emit('step', 'init_exec');
      await this.xcuitest.initExecSession();

      this.emit('step', 'launch_runner');
      const appEnv: Record<string, string> = {
        CA_ASSERT_MAIN_THREAD_TRANSACTIONS: '0',
        CA_DEBUG_TRANSACTIONS: '0',
        DYLD_INSERT_LIBRARIES: '/Developer/usr/lib/libMainThreadChecker.dylib',
        DYLD_FRAMEWORK_PATH: '/System/Developer/Library/Frameworks',
        DYLD_LIBRARY_PATH: '/System/Developer/usr/lib',
        MTC_CRASH_ON_REPORT: '1',
        NSUnbufferedIO: 'YES',
        OS_ACTIVITY_DT_MODE: 'YES',
        SQLITE_ENABLE_THREAD_ASSERTIONS: '1',
        XCTestBundlePath: testBundlePath,
        XCTestConfigurationFilePath: '',
        XCTestManagerVariant: 'DDI',
        XCTestSessionIdentifier: sessionId.toUpperCase(),
        ...(this.options.launchEnvironment ?? {}),
      };

      this.launchedPid = await this.services.processControl.launch({
        bundleId: this.options.testRunnerBundleId,
        environment: appEnv,
        arguments: this.options.launchArguments ?? [],
        killExisting: this.options.killExisting ?? true,
      });

      this.emit('step', 'authorize_and_run');
      this.xcuitest.startExecCallbackListener(testBundlePath);
      await this.xcuitest.initControlSessionAndAuthorize(
        Math.abs(this.launchedPid),
      );
      await this.xcuitest.startExecutingTestPlan();

      const deadline = Date.now() + timeoutMs;
      while (this.xcuitest.getIsRunning() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      const durationMs = Date.now() - startTime;
      const listenerError = this.xcuitest.getLastListenerError();
      if (listenerError) {
        throw new Error(
          `Exec callback listener failed: ${listenerError.message}`,
        );
      }
      if (this.xcuitest.getIsRunning()) {
        return {
          status: 'timed_out',
          sessionIdentifier: sessionId,
          testRunnerPid: Math.abs(this.launchedPid),
          durationMs,
        };
      }

      return {
        status: 'passed',
        sessionIdentifier: sessionId,
        testRunnerPid: Math.abs(this.launchedPid),
        durationMs,
      };
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.services?.processControl && this.launchedPid) {
      await this.services.processControl
        .kill(Math.abs(this.launchedPid))
        .catch(() => {});
      this.launchedPid = 0;
    }

    if (this.xcuitest) {
      await this.xcuitest.stop().catch(() => {});
      this.xcuitest = null;
    }

    if (this.services?.dvtService) {
      await this.services.dvtService.close().catch(() => {});
    }
    this.services = null;
  }
}

/** Create a high-level XCTest runner instance. */
export async function createXCTestRunner(
  options: XCTestRunnerOptions,
): Promise<XCTestRunner> {
  return new XCTestRunner(options);
}

/** High-level API to run an XCTest bundle. */
export async function runXCTest(
  options: XCTestRunnerOptions,
): Promise<XCTestRunResult> {
  const runner = await createXCTestRunner(options);
  return await runner.run();
}
