import { timing } from '@appium/support';
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
import { InstallationProxyService } from '../installation-proxy/index.js';
import {
  DEFAULT_EXEC_CAPABILITIES,
  DEFAULT_LAUNCH_ENV,
  type DeferredPromise,
  SELECTOR,
  TESTMANAGERD_CHANNEL,
  XCODE_VERSION,
  type XCTestEvent,
  XCTestEventType,
  XCTestRunError,
  type XCTestRunResult,
  type XCTestRunStage,
  type XCTestRunnerEvents,
  type XCTestRunnerOptions,
  type XCTestSummary,
  type XCUITestOptions,
  type XCUITestServiceEvents,
  createDeferred,
  getXctestNameFromBundleId,
  isTransportError,
  parseCallback,
} from './xctest-common.js';
import {
  XCTestConfigurationEncoder,
  type XCTestConfigurationParams,
} from './xctestconfiguration.js';

const log = getLogger('XCUITestService');

// #region XCUITestService

/**
 * XCUITestService orchestrates the full XCTest launch lifecycle
 * using the iOS 17+ testmanagerd capabilities-based protocol.
 *
 * It coordinates testmanagerd (control + exec connections) to run
 * XCTest sessions without xcodebuild.
 *
 * Flow (iOS 18+):
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
 * const status = await xcuitest.waitForCompletion();
 * await xcuitest.stop();
 * ```
 */
export class XCUITestService extends EventEmitter<XCUITestServiceEvents> {
  private readonly controlConnection: TestmanagerdService;
  private readonly execConnection: TestmanagerdService;
  private readonly options: XCUITestOptions;
  private readonly xcodeVersion: number;

  private controlChannelCode: number = 0;
  private execChannelCode: number = 0;
  private _testProcessPid: number = 0;
  private _sessionIdentifier: string;
  private _running: boolean = false;
  private configPayload: Buffer | null = null;
  private callbackListenerPromise: Promise<void> | null = null;
  private listenerAbortController: AbortController | null = null;
  private _lastListenerError: Error | null = null;
  private configReplyDeferred: DeferredPromise<void> | null = null;
  private finishedDeferred: DeferredPromise<'passed' | 'failed'> | null = null;
  private _lastTestSummary: XCTestSummary | null = null;

  constructor(config: {
    controlConnection: TestmanagerdService;
    execConnection: TestmanagerdService;
    options: XCUITestOptions;
  }) {
    super();
    this.controlConnection = config.controlConnection;
    this.execConnection = config.execConnection;
    this.options = config.options;
    this.xcodeVersion = config.options.xcodeVersion ?? XCODE_VERSION;
    this._sessionIdentifier = crypto.randomUUID();
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
    args.appendObj({ __type: 'NSUUID', uuid: this._sessionIdentifier });
    args.appendObj({
      __type: 'XCTCapabilities',
      capabilities: DEFAULT_EXEC_CAPABILITIES,
    });

    await this.execConnection.sendMessage(
      this.execChannelCode,
      SELECTOR.initiateSession,
      { args },
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
    this._lastListenerError = null;
    this._lastTestSummary = null;
    this.configReplyDeferred = createDeferred<void>();
    this.finishedDeferred = createDeferred<'passed' | 'failed'>();
    this.listenerAbortController = new AbortController();
    const { signal } = this.listenerAbortController;

    const listenerPromise: Promise<void> = (async () => {
      while (!signal.aborted) {
        try {
          const result = await this.execConnection.recvPlistWithTimeout(
            this.execChannelCode,
            1000,
          );

          if (!result) {
            continue; // Timeout — poll again
          }

          const [selector, auxiliaries] = result;
          this.handleCallback(selector, auxiliaries);

          if (selector === SELECTOR.testRunnerReady && this.configPayload) {
            log.info(
              'Test runner ready. Sending XCTestConfiguration response...',
            );
            await this.execConnection.sendReply(
              this.execChannelCode,
              this.configPayload,
            );
            log.info('XCTestConfiguration response sent');
            this.configReplyDeferred?.resolve();
          }

          if (selector === SELECTOR.testPlanFinished) {
            this._running = false;
            const status =
              this._lastTestSummary && this._lastTestSummary.failureCount > 0
                ? 'failed'
                : 'passed';
            this.finishedDeferred?.resolve(status);
            break;
          }
        } catch (err: any) {
          if (signal.aborted) {
            break;
          }
          this._lastListenerError =
            err instanceof Error ? err : new Error(String(err));
          this._running = false;

          // Unblock startExecutingTestPlan if it's waiting for config reply
          this.configReplyDeferred?.resolve();
          this.configReplyDeferred = null;

          if (isTransportError(err)) {
            log.debug(
              `Exec listener transport error: ${this._lastListenerError.message}`,
            );
          } else {
            log.debug(
              `Exec listener protocol error: ${this._lastListenerError.message}`,
            );
          }

          this.finishedDeferred?.resolve('failed');
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
    this._testProcessPid = pid;

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
      SELECTOR.initiateControlSession,
      { args: controlArgs },
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
      SELECTOR.authorizeTestSession,
      { args: authArgs },
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
    if (this.configReplyDeferred) {
      log.debug(
        'Waiting for XCTestConfiguration reply before starting test plan...',
      );
      await this.configReplyDeferred.promise;
    }

    log.debug('Starting test plan execution...');

    const args = new MessageAux();
    args.appendObj(this.xcodeVersion);

    // Magic channel -1 for test plan execution
    await this.execConnection.sendMessage(-1, SELECTOR.startTestPlan, {
      args,
      expectsReply: false,
    });

    this._running = true;
    log.info('Test plan execution started');
  }

  /**
   * Wait for the test plan to finish or error out.
   * Returns 'passed' or 'failed' based on test results.
   */
  async waitForCompletion(): Promise<'passed' | 'failed'> {
    if (!this.finishedDeferred) {
      throw new Error(
        'startExecCallbackListener must be called before waitForCompletion',
      );
    }
    return await this.finishedDeferred.promise;
  }

  /**
   * Stop the XCUITest session.
   * Immediately aborts the background listener and closes both
   * testmanagerd connections.
   */
  async stop(): Promise<void> {
    log.info('Stopping XCUITest session...');

    this._running = false;

    // Resolve deferred promises so nothing hangs
    this.configReplyDeferred?.resolve();
    this.configReplyDeferred = null;
    this.finishedDeferred?.resolve('failed');
    this.finishedDeferred = null;

    // Immediately abort the background listener
    this.listenerAbortController?.abort();

    if (this.callbackListenerPromise) {
      try {
        await this.callbackListenerPromise;
      } catch (error) {
        log.debug('Error awaiting callback listener during stop:', error);
      }
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

  get sessionIdentifier(): string {
    return this._sessionIdentifier;
  }

  get testProcessPid(): number {
    return this._testProcessPid;
  }

  get isRunning(): boolean {
    return this._running;
  }

  get lastListenerError(): Error | null {
    return this._lastListenerError;
  }

  get lastTestSummary(): XCTestSummary | null {
    return this._lastTestSummary;
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
      sessionIdentifier: this._sessionIdentifier,
      targetApplicationBundleID: this.options.targetBundleId,
      targetApplicationPath: this.options.targetAppPath,
      initializeForUITesting: this.options.initializeForUITesting ?? true,
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

    const event = parseCallback(selector, auxiliaries);
    this.emit('xctest', event);

    switch (event.type) {
      case XCTestEventType.Log:
        log.debug(`[XCTest] ${event.message}`);
        break;

      case XCTestEventType.TestRunnerReady:
        log.debug('Test runner ready with capabilities');
        break;

      case XCTestEventType.TestBundleReady:
        log.debug(
          `Test bundle ready. Protocol: ${event.protocolVersion}, Min: ${event.minimumVersion}`,
        );
        break;

      case XCTestEventType.TestCaseStarted:
        log.debug(`Test case started: ${event.identifier}`);
        break;

      case XCTestEventType.TestCaseFailed:
        log.debug(
          `Test case failed: ${event.testClass}/${event.method} - ${event.message} (${event.file}:${event.line})`,
        );
        break;

      case XCTestEventType.TestCaseFinished:
        log.debug(
          `Test case finished: ${event.identifier} - status: ${event.status} (${event.duration}s)`,
        );
        break;

      case XCTestEventType.TestSuiteStarted:
        log.debug(`Test suite started: ${event.identifier}`);
        break;

      case XCTestEventType.TestSuiteFinished:
        log.debug(
          `Test suite finished: ${event.identifier} - run: ${event.runCount}, skip: ${event.skipCount}, fail: ${event.failureCount}`,
        );
        this._lastTestSummary = {
          runCount: event.runCount,
          skipCount: event.skipCount,
          failureCount: event.failureCount,
          expectedFailureCount: event.expectedFailureCount,
          uncaughtExceptionCount: event.uncaughtExceptionCount,
          testDuration: event.testDuration,
          totalDuration: event.totalDuration,
        };
        break;

      case XCTestEventType.TestPlanFinished:
        log.info('Test plan execution finished');
        // State update (this._running) and deferred resolution handled by the listener loop
        break;

      case XCTestEventType.Unknown:
        log.debug(`Callback: ${event.selector}`);
        break;
    }
  }
}

// #endregion

// #region XCTestRunner

type InstalledAppInfo = {
  Path?: string;
  CFBundleExecutable?: string;
};

/**
 * High-level XCTest runner that manages service setup, launch, execution, and cleanup.
 */
export class XCTestRunner extends EventEmitter<XCTestRunnerEvents> {
  private readonly options: XCTestRunnerOptions;
  private services: XCTestServices | null = null;
  private installationProxy: InstallationProxyService | null = null;
  private xcuitest: XCUITestService | null = null;
  private launchedPid: number = 0;

  constructor(options: XCTestRunnerOptions) {
    super();
    this.options = options;
  }

  async run(): Promise<XCTestRunResult> {
    const timer = new timing.Timer().start();

    try {
      await this.setupAndLaunch();
      return await this.executeAndWait(timer);
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.installationProxy) {
      this.installationProxy.close();
      this.installationProxy = null;
    }

    if (this.services?.processControl && this.launchedPid) {
      try {
        await this.services.processControl.kill(Math.abs(this.launchedPid));
      } catch (error) {
        log.debug('Error killing test runner process:', error);
      }
      this.launchedPid = 0;
    }

    if (this.xcuitest) {
      try {
        await this.xcuitest.stop();
      } catch (error) {
        log.debug('Error stopping xcuitest service:', error);
      }
      this.xcuitest = null;
    }

    if (this.services?.dvtService) {
      try {
        await this.services.dvtService.close();
      } catch (error) {
        log.debug('Error closing DVT service:', error);
      }
    }
    this.services = null;
  }

  private async setupAndLaunch(): Promise<void> {
    this.emit('step', 'start_services');
    const services = await this.startServices();

    this.emit('step', 'lookup_apps');
    const { targetPath, testBundlePath, xctestName } = await this.lookupApps();

    this.xcuitest = new XCUITestService({
      controlConnection: services.controlTestmanagerd,
      execConnection: services.execTestmanagerd,
      options: {
        udid: this.options.udid,
        xctestBundleId: this.options.testRunnerBundleId,
        targetBundleId: this.options.appUnderTestBundleId,
        targetAppPath: targetPath,
        productModuleName: xctestName,
        xcodeVersion: this.options.xcodeVersion,
        initializeForUITesting: this.options.testType !== 'app',
      },
    });

    // Forward typed events
    this.xcuitest.on('xctest', (event: XCTestEvent) => {
      this.emit('xctest', event);
    });

    this.emit('step', 'init_exec');
    try {
      await this.xcuitest.initExecSession();
    } catch (err) {
      throw new XCTestRunError(
        `Failed to initialize exec session: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'init_exec', cause: err },
      );
    }

    this.emit('step', 'launch_runner');
    try {
      const sessionId = this.xcuitest.sessionIdentifier;
      const appEnv: Record<string, string> = {
        ...DEFAULT_LAUNCH_ENV,
        XCTestBundlePath: testBundlePath,
        XCTestSessionIdentifier: sessionId.toUpperCase(),
        ...(this.options.launchEnvironment ?? {}),
      };

      this.launchedPid = await services.processControl.launch({
        bundleId: this.options.testRunnerBundleId,
        environment: appEnv,
        arguments: this.options.launchArguments ?? [],
        killExisting: this.options.killExisting ?? true,
      });
    } catch (err) {
      throw new XCTestRunError(
        `Failed to launch test runner: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'launch_runner', cause: err },
      );
    }

    this.xcuitest.startExecCallbackListener(testBundlePath);

    this.emit('step', 'authorize');
    try {
      await this.xcuitest.initControlSessionAndAuthorize(
        Math.abs(this.launchedPid),
      );
    } catch (err) {
      throw new XCTestRunError(
        `Failed to authorize test session: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'authorize', cause: err },
      );
    }

    this.emit('step', 'start_plan');
    try {
      await this.xcuitest.startExecutingTestPlan();
    } catch (err) {
      throw new XCTestRunError(
        `Failed to start test plan: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'start_plan', cause: err },
      );
    }
  }

  private async executeAndWait(
    timer: InstanceType<typeof timing.Timer>,
  ): Promise<XCTestRunResult> {
    const timeoutMs = this.options.timeoutMs ?? 180000;
    const sessionId = this.xcuitest!.sessionIdentifier;

    this.emit('step', 'wait_finish');
    const timeout = new Promise<'timed_out'>((resolve) =>
      setTimeout(() => resolve('timed_out'), timeoutMs),
    );
    const raceResult = await Promise.race([
      this.xcuitest!.waitForCompletion(),
      timeout,
    ]);

    const durationMs = Math.round(timer.getDuration().asMilliSeconds);
    const testSummary = this.xcuitest!.lastTestSummary ?? undefined;
    const listenerError = this.xcuitest!.lastListenerError;

    if (raceResult === 'timed_out') {
      return {
        status: 'timed_out',
        sessionIdentifier: sessionId,
        testRunnerPid: Math.abs(this.launchedPid),
        durationMs,
        testSummary,
      };
    }

    if (listenerError) {
      return {
        status: 'failed',
        sessionIdentifier: sessionId,
        testRunnerPid: Math.abs(this.launchedPid),
        durationMs,
        error: `Exec callback listener failed: ${listenerError.message}`,
        testSummary,
      };
    }

    return {
      status: raceResult,
      sessionIdentifier: sessionId,
      testRunnerPid: Math.abs(this.launchedPid),
      durationMs,
      testSummary,
    };
  }

  private async startServices(): Promise<XCTestServices> {
    try {
      const services = await Services.startXCTestServices(this.options.udid, {
        includeInstallationProxy: true,
      });
      this.services = services;
      this.installationProxy = services.installationProxy ?? null;
      return services;
    } catch (err) {
      throw new XCTestRunError(
        `Failed to start XCTest services: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'start_services', cause: err },
      );
    }
  }

  private async lookupApps(): Promise<{
    runnerPath: string;
    targetPath: string;
    testBundlePath: string;
    xctestName: string;
  }> {
    if (!this.installationProxy) {
      throw new XCTestRunError(
        'Installation proxy not available for app lookup',
        { stage: 'lookup_apps' },
      );
    }

    try {
      const appLookup = await this.installationProxy.lookup(
        [this.options.testRunnerBundleId, this.options.appUnderTestBundleId],
        { returnAttributes: ['Path', 'CFBundleExecutable'] },
      );
      this.installationProxy.close();
      this.installationProxy = null;

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

      return { runnerPath, targetPath, testBundlePath, xctestName };
    } catch (err) {
      if (err instanceof XCTestRunError) {
        throw err;
      }
      throw new XCTestRunError(
        `Failed to look up installed apps: ${err instanceof Error ? err.message : String(err)}`,
        { stage: 'lookup_apps', cause: err },
      );
    }
  }
}

// #endregion

/** High-level XCTest runner instance. */
export function createXCTestRunner(options: XCTestRunnerOptions): XCTestRunner {
  return new XCTestRunner(options);
}

/** High-level API to run an XCTest bundle. */
export async function runXCTest(
  options: XCTestRunnerOptions,
): Promise<XCTestRunResult> {
  const runner = createXCTestRunner(options);
  return await runner.run();
}
