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
import { decodeNSKeyedArchiver } from '../dvt/nskeyedarchiver-decoder.js';
import { InstallationProxyService } from '../installation-proxy/index.js';
import {
  XCTestConfigurationEncoder,
  type XCTestConfigurationParams,
} from './xctestconfiguration.js';

const log = getLogger('XCUITestService');

// #region Constants

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

/** Selector strings used in testmanagerd protocol communication. */
const SELECTOR = {
  // IDE → device (exec session)
  initiateSession: '_IDE_initiateSessionWithIdentifier:capabilities:',
  startTestPlan: '_IDE_startExecutingTestPlanWithProtocolVersion:',

  // IDE → device (control session)
  initiateControlSession: '_IDE_initiateControlSessionWithCapabilities:',
  authorizeTestSession: '_IDE_authorizeTestSessionWithProcessID:',

  // Device → IDE (exec callbacks)
  logDebugMessage: '_XCT_logDebugMessage:',
  testRunnerReady: '_XCT_testRunnerReadyWithCapabilities:',
  testBundleReady: '_XCT_testBundleReadyWithProtocolVersion:minimumVersion:',
  testCaseStarted:
    '_XCT_testCaseDidStartWithIdentifier:testCaseRunConfiguration:',
  testCaseFailed:
    '_XCT_testCaseDidFailForTestClass:method:withMessage:file:line:',
  testCaseFinished: '_XCT_testCaseWithIdentifier:didFinishWithStatus:duration:',
  testSuiteStarted: '_XCT_testSuiteWithIdentifier:didStartAt:',
  testSuiteFinished:
    '_XCT_testSuiteWithIdentifier:didFinishAt:runCount:skipCount:failureCount:expectedFailureCount:uncaughtExceptionCount:testDuration:totalDuration:',
  testPlanFinished: '_XCT_didFinishExecutingTestPlan',
} as const;

/** Default environment variables for launching the test runner process. */
const DEFAULT_LAUNCH_ENV: Record<string, string> = {
  CA_ASSERT_MAIN_THREAD_TRANSACTIONS: '0',
  CA_DEBUG_TRANSACTIONS: '0',
  DYLD_INSERT_LIBRARIES: '/Developer/usr/lib/libMainThreadChecker.dylib',
  DYLD_FRAMEWORK_PATH: '/System/Developer/Library/Frameworks',
  DYLD_LIBRARY_PATH: '/System/Developer/usr/lib',
  MTC_CRASH_ON_REPORT: '1',
  NSUnbufferedIO: 'YES',
  OS_ACTIVITY_DT_MODE: 'YES',
  SQLITE_ENABLE_THREAD_ASSERTIONS: '1',
  XCTestConfigurationFilePath: '',
  XCTestManagerVariant: 'DDI',
};

/** Transport error codes that indicate connection-level failures. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
]);

// #endregion

// #region Utilities

/** A minimal deferred promise wrapper. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

/** Extract the xctest module name from a bundle identifier. */
export function getXctestNameFromBundleId(xctestBundleId: string): string {
  return xctestBundleId.split('.').at(-1) || xctestBundleId;
}

/**
 * Resolve an auxiliary value to a string identifier.
 *
 * DTX auxiliary objects may be:
 * - A plain string (already resolved)
 * - An NSKeyedArchiver-encoded object (e.g., XCTTestIdentifier)
 *   which decodes to `{ c: ['TestClass', 'testMethod'], ... }`
 *   where `c` = components, `ocm` = onlyCountMatches, `os` = ordered set
 * - A raw object/dict that needs stringification
 */
function resolveTestIdentifier(value: any): string {
  if (typeof value === 'string') {
    return value;
  }

  // Try decoding NSKeyedArchiver if it's an archived object
  let decoded = value;
  if (
    value &&
    typeof value === 'object' &&
    value.$archiver === 'NSKeyedArchiver'
  ) {
    try {
      decoded = decodeNSKeyedArchiver(value);
    } catch {
      // Fall through to other strategies
    }
  }

  if (typeof decoded === 'string') {
    return decoded;
  }

  if (decoded && typeof decoded === 'object') {
    // XCTTestIdentifier uses abbreviated keys:
    //   c = components, e.g. ['BasicUITests', 'testExample']
    const components = decoded.c ?? decoded.components;
    if (Array.isArray(components) && components.length > 0) {
      return components.filter((v: any) => typeof v === 'string').join('/');
    }
    if (typeof decoded.identifier === 'string') {
      return decoded.identifier;
    }
    if (typeof decoded.name === 'string') {
      return decoded.name;
    }
  }

  // Last resort
  return JSON.stringify(value);
}

function isTransportError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof (err as NodeJS.ErrnoException).code === 'string' &&
    TRANSPORT_ERROR_CODES.has((err as NodeJS.ErrnoException).code!)
  );
}

// #endregion

// #region Event Types

/** Discriminated union of typed XCTest callback events. */
export type XCTestEvent =
  | { type: 'log'; message: string }
  | { type: 'testRunnerReady' }
  | {
      type: 'testBundleReady';
      protocolVersion: number;
      minimumVersion: number;
    }
  | { type: 'testCaseStarted'; identifier: string }
  | {
      type: 'testCaseFailed';
      testClass: string;
      method: string;
      message: string;
      file: string;
      line: number;
    }
  | {
      type: 'testCaseFinished';
      identifier: string;
      status: string;
      duration: number;
    }
  | { type: 'testSuiteStarted'; identifier: string }
  | {
      type: 'testSuiteFinished';
      identifier: string;
      runCount: number;
      skipCount: number;
      failureCount: number;
    }
  | { type: 'testPlanFinished' }
  | { type: 'unknown'; selector: string };

/** Parse a raw callback selector + auxiliaries into a typed event. */
export function parseCallback(
  selector: string,
  auxiliaries: any[],
): XCTestEvent {
  switch (selector) {
    case SELECTOR.logDebugMessage:
      return {
        type: 'log',
        message:
          typeof auxiliaries[0] === 'string'
            ? auxiliaries[0]
            : JSON.stringify(auxiliaries[0]),
      };

    case SELECTOR.testRunnerReady:
      return { type: 'testRunnerReady' };

    case SELECTOR.testBundleReady:
      return {
        type: 'testBundleReady',
        protocolVersion: Number(auxiliaries[0]),
        minimumVersion: Number(auxiliaries[1]),
      };

    case SELECTOR.testCaseStarted:
      return {
        type: 'testCaseStarted',
        identifier: resolveTestIdentifier(auxiliaries[0]),
      };

    case SELECTOR.testCaseFailed:
      return {
        type: 'testCaseFailed',
        testClass: resolveTestIdentifier(auxiliaries[0]),
        method: resolveTestIdentifier(auxiliaries[1]),
        message: resolveTestIdentifier(auxiliaries[2]),
        file: resolveTestIdentifier(auxiliaries[3]),
        line: Number(auxiliaries[4] ?? 0),
      };

    case SELECTOR.testCaseFinished:
      return {
        type: 'testCaseFinished',
        identifier: resolveTestIdentifier(auxiliaries[0]),
        status: resolveTestIdentifier(auxiliaries[1]),
        duration: Number(auxiliaries[2]),
      };

    case SELECTOR.testSuiteStarted:
      return {
        type: 'testSuiteStarted',
        identifier: resolveTestIdentifier(auxiliaries[0]),
      };

    case SELECTOR.testSuiteFinished:
      return {
        type: 'testSuiteFinished',
        identifier: resolveTestIdentifier(auxiliaries[0]),
        runCount: Number(auxiliaries[2]),
        skipCount: Number(auxiliaries[3]),
        failureCount: Number(auxiliaries[4]),
      };

    case SELECTOR.testPlanFinished:
      return { type: 'testPlanFinished' };

    default:
      return { type: 'unknown', selector };
  }
}

// #endregion

// #region Error Types

/** Stages of the XCTest run lifecycle, used for error context. */
export type XCTestRunStage =
  | 'start_services'
  | 'lookup_apps'
  | 'init_exec'
  | 'launch_runner'
  | 'authorize'
  | 'start_plan'
  | 'wait_finish';

/** Structured error with stage context for XCTest run failures. */
export class XCTestRunError extends Error {
  readonly stage: XCTestRunStage;
  readonly selector?: string;
  readonly recoverable: boolean;

  constructor(
    message: string,
    options: {
      stage: XCTestRunStage;
      selector?: string;
      recoverable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'XCTestRunError';
    this.stage = options.stage;
    this.selector = options.selector;
    this.recoverable = options.recoverable ?? false;
  }
}

// #endregion

// #region Option & Result Types

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
  /** Whether to initialize for UI testing (default: true) */
  initializeForUITesting?: boolean;
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
  /** Xcode protocol version */
  xcodeVersion?: number;
  /** Extra launch environment variables */
  launchEnvironment?: Record<string, string>;
  /** Launch arguments */
  launchArguments?: string[];
  /** Kill existing runner process before launch (default: true) */
  killExisting?: boolean;
  /** Test type: 'ui' initializes for UI testing, 'app' does not (default: 'ui') */
  testType?: 'ui' | 'app';
}

/** Test summary counts parsed from test suite finished callback. */
export interface XCTestSummary {
  runCount: number;
  skipCount: number;
  failureCount: number;
}

/** Result returned by high-level XCTest run */
export interface XCTestRunResult {
  status: 'passed' | 'failed' | 'timed_out';
  sessionIdentifier: string;
  testRunnerPid: number;
  durationMs: number;
  error?: string;
  testSummary?: XCTestSummary;
}

// #endregion

// #region XCUITestService

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
 * const status = await xcuitest.waitForCompletion();
 * await xcuitest.stop();
 * ```
 */
export class XCUITestService extends EventEmitter {
  private readonly controlConnection: TestmanagerdService;
  private readonly execConnection: TestmanagerdService;
  private readonly options: XCUITestOptions;
  private readonly xcodeVersion: number;

  private controlChannelCode: number = 0;
  private execChannelCode: number = 0;
  private testProcessPid: number = 0;
  private sessionIdentifier: string;
  private running: boolean = false;
  private configPayload: Buffer | null = null;
  private callbackListenerPromise: Promise<void> | null = null;
  private listenerAbortController: AbortController | null = null;
  private lastListenerError: Error | null = null;
  private configReplyDeferred: Deferred<void> | null = null;
  private finishedDeferred: Deferred<'passed' | 'failed'> | null = null;
  private lastTestSummary: XCTestSummary | null = null;

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
      SELECTOR.initiateSession,
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
    this.lastTestSummary = null;
    this.configReplyDeferred = new Deferred<void>();
    this.finishedDeferred = new Deferred<'passed' | 'failed'>();
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

          if (
            typeof selector === 'string' &&
            selector.startsWith(SELECTOR.testPlanFinished)
          ) {
            this.running = false;
            const status =
              this.lastTestSummary && this.lastTestSummary.failureCount > 0
                ? 'failed'
                : 'passed';
            this.finishedDeferred?.resolve(status);
            break;
          }
        } catch (err: any) {
          if (signal.aborted) {
            break;
          }
          this.lastListenerError =
            err instanceof Error ? err : new Error(String(err));
          this.running = false;

          if (isTransportError(err)) {
            log.debug(
              `Exec listener transport error: ${this.lastListenerError.message}`,
            );
          } else {
            log.debug(
              `Exec listener protocol error: ${this.lastListenerError.message}`,
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
      SELECTOR.initiateControlSession,
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
      SELECTOR.authorizeTestSession,
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
    await this.execConnection.sendMessage(
      -1,
      SELECTOR.startTestPlan,
      args,
      false,
    );

    this.running = true;
    log.info('Test plan execution started');
  }

  /**
   * Wait for the test plan to finish or error out.
   * Returns 'passed' or 'failed' based on test results.
   */
  async waitForCompletion(): Promise<'passed' | 'failed'> {
    if (!this.finishedDeferred) {
      return 'passed';
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

    this.running = false;

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
  isTestRunning(): boolean {
    return this.running;
  }

  getLastListenerError(): Error | null {
    return this.lastListenerError;
  }

  getLastTestSummary(): XCTestSummary | null {
    return this.lastTestSummary;
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
      case 'log':
        log.debug(`[XCTest] ${event.message}`);
        break;

      case 'testRunnerReady':
        log.debug('Test runner ready with capabilities');
        break;

      case 'testBundleReady':
        log.debug(
          `Test bundle ready. Protocol: ${event.protocolVersion}, Min: ${event.minimumVersion}`,
        );
        break;

      case 'testCaseStarted':
        log.debug(`Test case started: ${event.identifier}`);
        break;

      case 'testCaseFailed':
        log.debug(
          `Test case failed: ${event.testClass}/${event.method} - ${event.message} (${event.file}:${event.line})`,
        );
        break;

      case 'testCaseFinished':
        log.debug(
          `Test case finished: ${event.identifier} - status: ${event.status} (${event.duration}s)`,
        );
        break;

      case 'testSuiteStarted':
        log.debug(`Test suite started: ${event.identifier}`);
        break;

      case 'testSuiteFinished':
        log.debug(
          `Test suite finished: ${event.identifier} - run: ${event.runCount}, skip: ${event.skipCount}, fail: ${event.failureCount}`,
        );
        this.lastTestSummary = {
          runCount: event.runCount,
          skipCount: event.skipCount,
          failureCount: event.failureCount,
        };
        break;

      case 'testPlanFinished':
        log.info('Test plan execution finished');
        this.running = false;
        break;

      case 'unknown':
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
export class XCTestRunner extends EventEmitter {
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
    const timeoutMs = this.options.timeoutMs ?? 180000;
    const startTime = Date.now();

    try {
      this.emit('step', 'start_services');
      const services = await this.startServices();

      this.emit('step', 'lookup_apps');
      const { runnerPath, targetPath, testBundlePath, xctestName } =
        await this.lookupApps();

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

      const sessionId = this.xcuitest.getSessionIdentifier();

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

      this.emit('step', 'wait_finish');
      const timeout = new Promise<'timed_out'>((resolve) =>
        setTimeout(() => resolve('timed_out'), timeoutMs),
      );
      const raceResult = await Promise.race([
        this.xcuitest.waitForCompletion(),
        timeout,
      ]);

      const durationMs = Date.now() - startTime;
      const testSummary = this.xcuitest.getLastTestSummary() ?? undefined;
      const listenerError = this.xcuitest.getLastListenerError();

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
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.services?.processControl && this.launchedPid) {
      await this.services.processControl
        .kill(Math.abs(this.launchedPid))
        .catch((error) => {
          log.debug('Error killing test runner process:', error);
        });
      this.launchedPid = 0;
    }

    if (this.xcuitest) {
      await this.xcuitest.stop().catch((error) => {
        log.debug('Error stopping xcuitest service:', error);
      });
      this.xcuitest = null;
    }

    if (this.services?.dvtService) {
      await this.services.dvtService.close().catch((error) => {
        log.debug('Error closing DVT service:', error);
      });
    }
    this.services = null;
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

/** Create a high-level XCTest runner instance. */
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
