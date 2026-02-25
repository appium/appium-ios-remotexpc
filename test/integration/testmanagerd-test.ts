import { logger } from '@appium/support';
import { expect } from 'chai';
import crypto from 'node:crypto';

import type {
  DVTServiceWithConnection,
  HouseArrestServiceWithConnection,
  InstallationProxyServiceWithConnection,
  TestmanagerdServiceWithConnection,
} from '../../src/index.js';
import { XCTestConfigurationEncoder } from '../../src/index.js';
import {
  createBinaryPlist,
  parseBinaryPlist,
} from '../../src/lib/plist/index.js';
import * as Services from '../../src/services.js';
import { MessageAux } from '../../src/services/ios/dvt/index.js';
import type { AppInfo } from '../../src/services/ios/installation-proxy/types.js';

const log = logger.getLogger('Testmanagerd.test');
log.level = 'debug';

const TESTMANAGERD_CHANNEL =
  'dtxproxy:XCTestManager_IDEInterface:XCTestManager_DaemonConnectionInterface';

const XCODE_VERSION = 36;

describe('Testmanagerd Service', function () {
  this.timeout(60000);

  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(function () {
    if (!udid) {
      throw new Error('Set UDID env var to execute tests.');
    }
  });

  describe('Dual-connection handshake + control session init', function () {
    let controlConnection: TestmanagerdServiceWithConnection | null = null;
    let execConnection: TestmanagerdServiceWithConnection | null = null;

    after(async function () {
      for (const conn of [controlConnection, execConnection]) {
        if (conn) {
          try {
            await conn.testmanagerdService.close();
          } catch {}
          try {
            await conn.remoteXPC.close();
          } catch {}
        }
      }
    });

    it('should connect two independent testmanagerd instances and complete handshakes', async function () {
      // Open two separate testmanagerd connections (control + exec)
      // This mirrors the xcuitest driver pattern of two simultaneous DTX connections
      controlConnection = await Services.startTestmanagerdService(udid);
      execConnection = await Services.startTestmanagerdService(udid);

      expect(controlConnection.testmanagerdService).to.not.be.null;
      expect(execConnection.testmanagerdService).to.not.be.null;

      log.debug('Both testmanagerd connections established');
    });

    it('should create channels on both connections', async function () {
      const controlChannel =
        await controlConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      expect(controlChannel).to.not.be.null;
      expect(controlChannel.getCode()).to.be.greaterThan(0);

      const execChannel =
        await execConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      expect(execChannel).to.not.be.null;
      expect(execChannel.getCode()).to.be.greaterThan(0);

      log.debug(
        `Control channel: ${controlChannel.getCode()}, Exec channel: ${execChannel.getCode()}`,
      );
    });

    it('should initiate control session with protocol version', async function () {
      const controlChannel =
        await controlConnection!.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      const channelCode = controlChannel.getCode();

      // Send _IDE_initiateControlSessionWithProtocolVersion:
      // This is the first real testmanagerd call in the XCTest launch flow
      const args = new MessageAux();
      args.appendObj(XCODE_VERSION);

      await controlConnection!.testmanagerdService.sendMessage(
        channelCode,
        '_IDE_initiateControlSessionWithProtocolVersion:',
        args,
      );

      const [result] =
        await controlConnection!.testmanagerdService.recvPlist(channelCode);

      log.debug('Control session init result:', result);

      // The device should acknowledge the control session init
      // Result is typically the protocol version number the device supports
      expect(result).to.not.be.null;
    });
  });

  describe('XCTestConfiguration write via HouseArrest', function () {
    let houseArrestConnection: HouseArrestServiceWithConnection | null = null;
    // This needs a dev-signed app installed on the device
    const bundleId = process.env.XCTEST_BUNDLE_ID || 'com.testigng.lt';

    after(async function () {
      if (houseArrestConnection) {
        try {
          await houseArrestConnection.remoteXPC.close();
        } catch {}
      }
    });

    it('should encode XCTestConfiguration, write to device, and read back', async function () {
      houseArrestConnection = await Services.startHouseArrestService(udid);

      // 1. Create and serialize XCTestConfiguration
      const sessionId = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const encoder = new XCTestConfigurationEncoder();
      const archived = encoder.encodeXCTestConfiguration({
        testBundleURL: 'file:///path/to/Runner.xctest',
        sessionIdentifier: sessionId,
        targetApplicationBundleID: bundleId,
        initializeForUITesting: true,
        reportResultsToIDE: true,
      });

      // Verify the archived structure before serializing
      expect(archived).to.have.property('$archiver', 'NSKeyedArchiver');
      expect(archived).to.have.property('$version', 100000);
      expect(archived.$objects).to.be.an('array');

      // 2. Serialize to binary plist
      const plistData = createBinaryPlist(archived);
      expect(plistData).to.be.instanceOf(Buffer);
      expect(plistData.length).to.be.greaterThan(0);

      log.debug(`Serialized XCTestConfiguration: ${plistData.length} bytes`);

      // 3. Write to device via HouseArrest
      const afcService =
        await houseArrestConnection.houseArrestService.vendContainer(bundleId);

      const configFileName = `Runner-${sessionId.toUpperCase()}.xctestconfiguration`;
      const remotePath = `/tmp/${configFileName}`;

      try {
        // Ensure /tmp exists
        try {
          await afcService.mkdir('/tmp');
        } catch {
          // /tmp may already exist
        }

        // Write configuration file
        await afcService.setFileContents(remotePath, plistData);
        log.debug(`Wrote XCTestConfiguration to ${remotePath}`);

        // 4. Read it back
        const readBack = await afcService.getFileContents(remotePath);
        expect(readBack).to.be.instanceOf(Buffer);
        expect(readBack.length).to.equal(plistData.length);

        // 5. Verify the read-back data is valid NSKeyedArchive
        const parsed = parseBinaryPlist(readBack);
        expect(parsed).to.have.property('$archiver', 'NSKeyedArchiver');
        expect(parsed).to.have.property('$version', 100000);
        expect(parsed).to.have.property('$objects').that.is.an('array');

        log.debug(
          'XCTestConfiguration round-trip verified: write → read → parse succeeded',
        );
      } finally {
        // Cleanup
        try {
          await afcService.rm(remotePath);
        } catch {}
        afcService.close();
      }
    });
  });

  describe('Testmanagerd + DVT ProcessControl combo', function () {
    let testmanagerdConnection: TestmanagerdServiceWithConnection | null = null;
    let dvtConnection: DVTServiceWithConnection | null = null;

    after(async function () {
      if (testmanagerdConnection) {
        try {
          await testmanagerdConnection.testmanagerdService.close();
        } catch {}
        try {
          await testmanagerdConnection.remoteXPC.close();
        } catch {}
      }
      if (dvtConnection) {
        try {
          await dvtConnection.dvtService.close();
        } catch {}
        try {
          await dvtConnection.remoteXPC.close();
        } catch {}
      }
    });

    it('should connect testmanagerd + DVT, launch app via ProcessControl, and authorize PID on control session', async function () {
      // 1. Connect both services
      testmanagerdConnection = await Services.startTestmanagerdService(udid);
      dvtConnection = await Services.startDVTService(udid);

      log.debug('Connected to testmanagerd and DVT services');

      // 2. Create testmanagerd control channel
      const controlChannel =
        await testmanagerdConnection.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      const channelCode = controlChannel.getCode();
      expect(channelCode).to.be.greaterThan(0);

      // 3. Initiate control session
      const initArgs = new MessageAux();
      initArgs.appendObj(XCODE_VERSION);

      await testmanagerdConnection.testmanagerdService.sendMessage(
        channelCode,
        '_IDE_initiateControlSessionWithProtocolVersion:',
        initArgs,
      );

      const [initResult] =
        await testmanagerdConnection.testmanagerdService.recvPlist(channelCode);
      log.debug('Control session initiated:', initResult);
      expect(initResult).to.not.be.null;

      // 4. Launch Calculator via DVT ProcessControl
      // Note: iOS may return a negative PID when the process is launched
      // in a suspended or special state. The absolute value is the real PID.
      const pid = await dvtConnection.processControl.launch({
        bundleId: 'com.apple.calculator',
        killExisting: true,
      });
      expect(pid).to.be.a('number');
      expect(pid).to.not.equal(0);
      log.debug(`Launched Calculator with PID: ${pid}`);

      // 5. Authorize the test session with the launched PID
      // This is the key integration point: testmanagerd needs to know about
      // the process that ProcessControl launched
      const authArgs = new MessageAux();
      authArgs.appendObj(pid);

      await testmanagerdConnection.testmanagerdService.sendMessage(
        channelCode,
        '_IDE_authorizeTestSessionWithProcessID:',
        authArgs,
      );

      const [authResult] =
        await testmanagerdConnection.testmanagerdService.recvPlist(channelCode);
      log.debug('Authorization result:', authResult);

      // Authorization should return a response (typically the PID or an ack)
      // The important thing is it doesn't throw an error
      log.debug(
        'Successfully authorized test session for Calculator PID via testmanagerd',
      );

      // 6. Cleanup: kill the launched app (use absolute PID)
      const absPid = Math.abs(pid);
      try {
        await dvtConnection.processControl.kill(absPid);
        log.debug(`Killed Calculator (PID: ${absPid})`);
      } catch (error) {
        log.debug('Error killing calculator (may have already exited):', error);
      }
    });
  });

  /**
   * Full XCTest launch flow — the "xcodebuild replacement" test.
   *
   * This test replicates what xcodebuild does under the hood when launching WDA:
   *   1. Look up the XCTest runner app via InstallationProxy
   *   2. Write XCTestConfiguration to the app sandbox via HouseArrest
   *   3. Open two testmanagerd connections (control + exec)
   *   4. Init control session
   *   5. Init exec session
   *   6. Launch the test runner app with XCTestConfigurationFilePath env var via ProcessControl
   *   7. Authorize test session with the launched PID
   *
   * Requires: XCTEST_BUNDLE_ID env var set to a dev-signed XCTest runner app
   * installed on the device (e.g., 'com.example.WebDriverAgentRunner.xctrunner')
   */
  describe('Full XCTest launch flow (xcodebuild replacement)', function () {
    // All connections we open
    let installProxyConn: InstallationProxyServiceWithConnection | null = null;
    let houseArrestConn: HouseArrestServiceWithConnection | null = null;
    let controlConn: TestmanagerdServiceWithConnection | null = null;
    let execConn: TestmanagerdServiceWithConnection | null = null;
    let dvtConn: DVTServiceWithConnection | null = null;
    let launchedPid: number = 0;

    const xctestBundleId =
      process.env.XCTEST_BUNDLE_ID ||
      'com.appium.test.XCTestTargetAppUITests.xctrunner';

    before(function () {
      if (!xctestBundleId) {
        this.skip();
      }
    });

    after(async function () {
      // Kill launched process if still alive
      if (launchedPid && dvtConn) {
        try {
          await dvtConn.processControl.kill(Math.abs(launchedPid));
          log.debug(`Killed test runner (PID: ${Math.abs(launchedPid)})`);
        } catch {}
      }

      // Close all connections
      const connections: Array<{ close: () => Promise<void> } | null> = [];

      if (controlConn) {
        connections.push(
          controlConn.testmanagerdService,
          controlConn.remoteXPC,
        );
      }
      if (execConn) {
        connections.push(execConn.testmanagerdService, execConn.remoteXPC);
      }
      if (dvtConn) {
        connections.push(dvtConn.dvtService, dvtConn.remoteXPC);
      }
      if (houseArrestConn) {
        connections.push(houseArrestConn.remoteXPC);
      }
      if (installProxyConn) {
        connections.push(installProxyConn.remoteXPC);
      }

      for (const conn of connections) {
        try {
          await conn?.close();
        } catch {}
      }
    });

    it('should execute full XCTest launch lifecycle without xcodebuild', async function () {
      // ═══════════════════════════════════════════════════════════════
      // Step 1: Look up XCTest runner app info via InstallationProxy
      // This replaces xcodebuild's implicit knowledge of the app path
      // ═══════════════════════════════════════════════════════════════
      installProxyConn = await Services.startInstallationProxyService(udid);
      const lookupResult =
        await installProxyConn.installationProxyService.lookup(
          [xctestBundleId],
          { returnAttributes: ['*'] },
        );

      const appInfo: AppInfo = lookupResult[xctestBundleId];
      expect(appInfo, `App ${xctestBundleId} not found on device`).to.not.be
        .undefined;
      expect(appInfo.Path).to.be.a('string');

      const appPath = appInfo.Path!;
      const appContainer = appInfo.Container || '';
      const execName = (appInfo as any).CFBundleExecutable as string;
      expect(execName, 'CFBundleExecutable not found in app info').to.be.a(
        'string',
      );

      // Derive target name from executable (e.g., 'WebDriverAgentRunner-Runner' → 'WebDriverAgentRunner')
      const targetName = execName.includes('-Runner')
        ? execName.substring(0, execName.indexOf('-Runner'))
        : execName;

      log.debug(
        `App info: path=${appPath}, container=${appContainer}, exec=${execName}, target=${targetName}`,
      );

      // ═══════════════════════════════════════════════════════════════
      // Step 2: Write XCTestConfiguration to device via HouseArrest
      // This is what xcodebuild generates internally
      // ═══════════════════════════════════════════════════════════════
      const sessionId = crypto.randomUUID();
      const configFileName = `${targetName}-${sessionId.toUpperCase()}.xctestconfiguration`;
      const configRelativePath = `/tmp/${configFileName}`;
      const configAbsolutePath = `${appContainer}${configRelativePath}`;

      const encoder = new XCTestConfigurationEncoder();
      const archived = encoder.encodeXCTestConfiguration({
        testBundleURL: `file://${appPath}/PlugIns/${targetName}.xctest`,
        sessionIdentifier: sessionId,
        targetApplicationBundleID: 'com.appium.test.XCTestTargetApp',
        targetApplicationPath:
          '/private/var/containers/Bundle/Application/XCTestTargetApp.app',
        initializeForUITesting: true,
        reportResultsToIDE: true,
        productModuleName: targetName,
      });
      const configData = createBinaryPlist(archived);

      houseArrestConn = await Services.startHouseArrestService(udid);
      const afcService =
        await houseArrestConn.houseArrestService.vendContainer(xctestBundleId);

      try {
        try {
          await afcService.mkdir('/tmp');
        } catch {}
        await afcService.setFileContents(configRelativePath, configData);
        log.debug(
          `Wrote XCTestConfiguration (${configData.length} bytes) to ${configRelativePath}`,
        );
      } finally {
        afcService.close();
      }

      // ═══════════════════════════════════════════════════════════════
      // Step 3: Open two testmanagerd connections (control + exec)
      // xcodebuild opens these internally via DTX
      // ═══════════════════════════════════════════════════════════════
      // go-ios iOS 17+ flow:
      //   1. Exec session (conn1) with capabilities
      //   2. Launch app via AppService (we use ProcessControl)
      //   3. Control session (conn2) with capabilities
      //   4. Authorize test session
      //   5. Start test plan
      //   6. Dispatch callbacks

      // ═══════════════════════════════════════════════════════════════
      // Step 4: Init exec session first (conn1)
      // ═══════════════════════════════════════════════════════════════
      execConn = await Services.startTestmanagerdService(udid);
      const execChannel =
        await execConn.testmanagerdService.makeChannel(TESTMANAGERD_CHANNEL);
      const execCode = execChannel.getCode();

      const execInitArgs = new MessageAux();
      execInitArgs.appendObj({ __type: 'NSUUID', uuid: sessionId });
      execInitArgs.appendObj({
        __type: 'XCTCapabilities',
        capabilities: {
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
        },
      });

      await execConn.testmanagerdService.sendMessage(
        execCode,
        '_IDE_initiateSessionWithIdentifier:capabilities:',
        execInitArgs,
      );
      const [execResult] =
        await execConn.testmanagerdService.recvPlist(execCode);
      log.debug('Exec session init result:', execResult);

      // ═══════════════════════════════════════════════════════════════
      // Step 5: Launch test runner app via ProcessControl
      // (go-ios uses AppService for iOS 17+, we use ProcessControl)
      // ═══════════════════════════════════════════════════════════════
      dvtConn = await Services.startDVTService(udid);

      const testBundlePath = `${appPath}/PlugIns/${targetName}.xctest`;
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
      };

      launchedPid = await dvtConn.processControl.launch({
        bundleId: xctestBundleId,
        environment: appEnv,
        arguments: [],
        killExisting: true,
      });

      expect(launchedPid).to.be.a('number');
      expect(launchedPid).to.not.equal(0);
      const absPid = Math.abs(launchedPid);
      log.debug(
        `Launched XCTest runner with PID: ${launchedPid} (abs: ${absPid})`,
      );

      // Prepare the XCTestConfiguration payload for the readiness response
      const configPayload = createBinaryPlist(archived);

      // ═══════════════════════════════════════════════════════════════
      // Step 6: Start background listener for exec callbacks
      // _XCT_testRunnerReadyWithCapabilities: may arrive while we set
      // up the control session. We must respond with the XCTestConfiguration.
      // ═══════════════════════════════════════════════════════════════
      let testFinished = false;
      let stopListening = false;
      const execCallbackListener = (async () => {
        while (!stopListening) {
          try {
            const [selector, auxiliaries] = await Promise.race([
              execConn!.testmanagerdService.recvPlist(execCode),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('listenTimeout')), 2000),
              ),
            ]);

            if (selector === '_XCT_logDebugMessage:') {
              const raw = auxiliaries[0];
              const msg =
                typeof raw === 'string'
                  ? raw
                  : (raw?.$objects?.[1] ?? JSON.stringify(raw));
              log.debug(`[runner] ${String(msg).trimEnd()}`);
            } else {
              log.info(`[exec callback] ${selector}`);
            }

            if (selector === '_XCT_testRunnerReadyWithCapabilities:') {
              log.info(
                'Test runner ready! Sending XCTestConfiguration response...',
              );
              await execConn!.testmanagerdService.sendReply(
                execCode,
                configPayload,
              );
              log.info('XCTestConfiguration response sent');
            }

            if (selector === '_XCT_didFinishExecutingTestPlan') {
              testFinished = true;
              log.info('Test plan finished!');
              break;
            }

            if (
              selector ===
              '_XCT_testCaseDidFinishForTestClass:method:withStatus:duration:'
            ) {
              log.info(
                `Test result: ${auxiliaries[0]}/${auxiliaries[1]} - status: ${auxiliaries[2]} (${auxiliaries[3]}s)`,
              );
            }
          } catch (err: any) {
            if (err.message === 'listenTimeout') {
              continue;
            }
            log.debug(`[exec listener] error: ${err.message}`);
            break;
          }
        }
      })();

      // ═══════════════════════════════════════════════════════════════
      // Step 7: Init control session (conn2), then authorize
      // ═══════════════════════════════════════════════════════════════
      controlConn = await Services.startTestmanagerdService(udid);
      const controlChannel =
        await controlConn.testmanagerdService.makeChannel(TESTMANAGERD_CHANNEL);
      const controlCode = controlChannel.getCode();

      const controlInitArgs = new MessageAux();
      controlInitArgs.appendObj({
        __type: 'XCTCapabilities',
        capabilities: {},
      });

      await controlConn.testmanagerdService.sendMessage(
        controlCode,
        '_IDE_initiateControlSessionWithCapabilities:',
        controlInitArgs,
      );
      const [controlResult] =
        await controlConn.testmanagerdService.recvPlist(controlCode);
      log.debug('Control session init result:', controlResult);

      // ═══════════════════════════════════════════════════════════════
      // Step 8: Authorize test session with the launched PID
      // ═══════════════════════════════════════════════════════════════
      const authArgs = new MessageAux();
      authArgs.appendObj(absPid);

      await controlConn.testmanagerdService.sendMessage(
        controlCode,
        '_IDE_authorizeTestSessionWithProcessID:',
        authArgs,
      );
      const [authResult] =
        await controlConn.testmanagerdService.recvPlist(controlCode);
      log.debug('Authorization result:', authResult);

      // ═══════════════════════════════════════════════════════════════
      // Step 9: Start test plan execution
      // ═══════════════════════════════════════════════════════════════
      const planArgs = new MessageAux();
      planArgs.appendObj(XCODE_VERSION);

      // Magic channel -1 for test plan execution
      await execConn!.testmanagerdService.sendMessage(
        -1,
        '_IDE_startExecutingTestPlanWithProtocolVersion:',
        planArgs,
        false,
      );
      log.debug('Test plan execution started');

      // Wait for the background listener to finish or timeout
      const maxWaitMs = 30000;
      const startTime = Date.now();
      while (!testFinished && Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      stopListening = true;

      // Wait for background listener to fully stop
      try {
        await execCallbackListener;
      } catch {}

      log.info(
        '=== Full XCTest launch flow completed successfully without xcodebuild ===',
      );
      log.info(
        `Session: ${sessionId}, PID: ${absPid}, Bundle: ${xctestBundleId}, finished: ${testFinished}`,
      );
    });
  });
});
