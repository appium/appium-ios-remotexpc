import { decodeNSKeyedArchiver } from '../dvt/nskeyedarchiver-decoder.js';

// #region Constants

/** Default Xcode protocol version */
export const XCODE_VERSION = 36;

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
export const SELECTOR = {
  // IDE → device (exec session)
  initiateSession: '_IDE_initiateSessionWithIdentifier:capabilities:',
  startTestPlan: '_IDE_startExecutingTestPlanWithProtocolVersion:',

  // IDE → device (control session)
  initiateControlSession: '_IDE_initiateControlSessionWithCapabilities:',
  authorizeTestSession: '_IDE_authorizeTestSessionWithProcessID:',

  /** IDE → daemon: remove attachments by UUID (XCTMessagingRole_AttachmentsDeleting). */
  deleteAttachmentsWithUUIDs: '_IDE_deleteAttachmentsWithUUIDs:',

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
export const DEFAULT_LAUNCH_ENV: Record<string, string> = {
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
export const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
]);

// #endregion

// #region Utilities

/** Deferred promise with externally accessible resolve/reject. */
export interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Create a deferred promise with externally accessible resolve/reject. */
export function createDeferred<T>(): DeferredPromise<T> {
  if ('withResolvers' in Promise) {
    // Node 22+ native implementation
    // @ts-expect-error -- Promise.withResolvers exists at runtime but lib is es2023
    return Promise.withResolvers<T>();
  }
  // Node 20 fallback
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Extract the xctest module name from a bundle identifier. */
export function getXctestNameFromBundleId(xctestBundleId: string): string {
  if (!xctestBundleId) {
    throw new Error('xctestBundleId must not be empty');
  }
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
export function resolveTestIdentifier(value: any): string {
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

export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code);
}

// #endregion

// #region Event Types

/** Event type constants for XCTest callback events. */
export const XCTestEventType = {
  Log: 'log',
  TestRunnerReady: 'testRunnerReady',
  TestBundleReady: 'testBundleReady',
  TestCaseStarted: 'testCaseStarted',
  TestCaseFailed: 'testCaseFailed',
  TestCaseFinished: 'testCaseFinished',
  TestSuiteStarted: 'testSuiteStarted',
  TestSuiteFinished: 'testSuiteFinished',
  TestPlanFinished: 'testPlanFinished',
  Unknown: 'unknown',
} as const;

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
      expectedFailureCount: number;
      uncaughtExceptionCount: number;
      testDuration: number;
      totalDuration: number;
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
        message:
          typeof auxiliaries[2] === 'string'
            ? auxiliaries[2]
            : String(auxiliaries[2] ?? ''),
        file:
          typeof auxiliaries[3] === 'string'
            ? auxiliaries[3]
            : String(auxiliaries[3] ?? ''),
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
        // auxiliaries[1] = didFinishAt (timestamp)
        runCount: Number(auxiliaries[2]),
        skipCount: Number(auxiliaries[3]),
        failureCount: Number(auxiliaries[4]),
        expectedFailureCount: Number(auxiliaries[5] ?? 0),
        uncaughtExceptionCount: Number(auxiliaries[6] ?? 0),
        testDuration: Number(auxiliaries[7] ?? 0),
        totalDuration: Number(auxiliaries[8] ?? 0),
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

/** Event map for XCUITestService — used for typed EventEmitter. */
export interface XCUITestServiceEvents {
  xctest: [event: XCTestEvent];
}

/** Event map for XCTestRunner — used for typed EventEmitter. */
export interface XCTestRunnerEvents {
  xctest: [event: XCTestEvent];
  step: [stage: XCTestRunStage];
}

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
  expectedFailureCount: number;
  uncaughtExceptionCount: number;
  testDuration: number;
  totalDuration: number;
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
