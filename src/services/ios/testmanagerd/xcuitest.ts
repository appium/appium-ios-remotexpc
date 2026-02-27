import crypto from 'node:crypto';

import { getLogger } from '../../../lib/logger.js';
import { createBinaryPlist } from '../../../lib/plist/index.js';
import { MessageAux } from '../dvt/dtx-message.js';
import type { DvtTestmanagedProxyService } from './index.js';
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
  private readonly controlConnection: DvtTestmanagedProxyService;
  private readonly execConnection: DvtTestmanagedProxyService;
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

  constructor(config: {
    controlConnection: DvtTestmanagedProxyService;
    execConnection: DvtTestmanagedProxyService;
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
          }

          if (selector === '_XCT_didFinishExecutingTestPlan') {
            this.isRunning = false;
            break;
          }
        } catch (err: any) {
          if (signal.aborted) {
            break;
          }
          log.debug(`Exec listener error: ${err.message}`);
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
   * Uses magic channel -1 (0xFFFFFFFF as signed int32).
   */
  async startExecutingTestPlan(): Promise<void> {
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
  getExecConnection(): DvtTestmanagedProxyService {
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
      initializeForUITesting: true,
      reportResultsToIDE: true,
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
          log.debug(`[XCTest] ${auxiliaries[0]}`);
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
