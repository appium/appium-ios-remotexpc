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
import {
  DEFAULT_EXEC_CAPABILITIES,
  TESTMANAGERD_CHANNEL,
} from '../../src/services/ios/testmanagerd/xcuitest.js';

const log = logger.getLogger('Testmanagerd.test');
log.level = 'debug';

const XCODE_VERSION = 36;

/**
 * Run:
 * `UDID=<device-udid> TEST_RUNNER_BUNDLE_ID=<xctrunner-bundle-id> APP_UNDER_TEST_BUNDLE_ID=<target-app-bundle-id> XCTEST_BUNDLE_ID=<xctest-bundle-id> npm run test:testmanagerd`
 *
 * Example:
 * `UDID=<device-udid> TEST_RUNNER_BUNDLE_ID=com.appium.test.XCTestTargetAppUITests.xctrunner APP_UNDER_TEST_BUNDLE_ID=com.appium.test.XCTestTargetApp XCTEST_BUNDLE_ID=com.appium.test.XCTestTargetAppUITests npm run test:testmanagerd`
 */

async function lookupInstalledApp(
  udid: string,
  bundleId: string,
): Promise<AppInfo> {
  const installProxyConn = await Services.startInstallationProxyService(udid);
  try {
    const lookup = await installProxyConn.installationProxyService.lookup(
      [bundleId],
      { returnAttributes: ['*'] },
    );
    const appInfo = lookup[bundleId];
    expect(appInfo, `App ${bundleId} not found on device`).to.not.be.undefined;
    return appInfo;
  } finally {
    try {
      await installProxyConn.remoteXPC.close();
    } catch {}
  }
}

function resolveTargetName(execName: string): string {
  return execName.includes('-Runner')
    ? execName.slice(0, execName.indexOf('-Runner'))
    : execName;
}

function getXctestNameFromBundleId(xctestBundleId: string): string {
  return xctestBundleId.split('.').at(-1) || xctestBundleId;
}

describe('Testmanagerd Service', function () {
  this.timeout(120000);

  const udid = process.env.UDID || '';

  before(function () {
    if (!udid) {
      throw new Error(
        'Set UDID. Example: UDID=<device-udid> TEST_RUNNER_BUNDLE_ID=com.appium.test.XCTestTargetAppUITests.xctrunner APP_UNDER_TEST_BUNDLE_ID=com.appium.test.XCTestTargetApp XCTEST_BUNDLE_ID=com.appium.test.XCTestTargetAppUITests npm run test:testmanagerd',
      );
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
      expect(result).to.not.be.null;
    });
  });

  describe('XCTestConfiguration write via HouseArrest', function () {
    let houseArrestConnection: HouseArrestServiceWithConnection | null = null;
    const testRunnerBundleId = process.env.TEST_RUNNER_BUNDLE_ID;
    const appUnderTestBundleId = process.env.APP_UNDER_TEST_BUNDLE_ID;
    const xctestBundleId = process.env.XCTEST_BUNDLE_ID;

    before(function () {
      if (!testRunnerBundleId || !appUnderTestBundleId || !xctestBundleId) {
        this.skip();
      }
    });

    after(async function () {
      if (houseArrestConnection) {
        try {
          await houseArrestConnection.remoteXPC.close();
        } catch {}
      }
    });

    it('should encode XCTestConfiguration, write to device, and read back', async function () {
      houseArrestConnection = await Services.startHouseArrestService(udid);
      const appInfo = await lookupInstalledApp(udid, testRunnerBundleId!);
      const appPath = appInfo.Path!;
      const xctestName = getXctestNameFromBundleId(xctestBundleId!);
      const testBundleURL = `file://${appPath}/PlugIns/${xctestName}.xctest`;

      const sessionId = 'AABBCCDD-1122-3344-5566-778899AABBCC';
      const encoder = new XCTestConfigurationEncoder();
      const archived = encoder.encodeXCTestConfiguration({
        testBundleURL,
        sessionIdentifier: sessionId,
        targetApplicationBundleID: appUnderTestBundleId!,
        initializeForUITesting: true,
        reportResultsToIDE: true,
      });

      expect(archived).to.have.property('$archiver', 'NSKeyedArchiver');
      expect(archived).to.have.property('$version', 100000);
      expect(archived.$objects).to.be.an('array');

      const plistData = createBinaryPlist(archived);
      expect(plistData).to.be.instanceOf(Buffer);
      expect(plistData.length).to.be.greaterThan(0);

      log.debug(`Serialized XCTestConfiguration: ${plistData.length} bytes`);

      const afcService =
        await houseArrestConnection.houseArrestService.vendContainer(
          testRunnerBundleId!,
        );

      const configFileName = `Runner-${sessionId.toUpperCase()}.xctestconfiguration`;
      const remotePath = `/tmp/${configFileName}`;

      try {
        try {
          await afcService.mkdir('/tmp');
        } catch {}

        await afcService.setFileContents(remotePath, plistData);
        log.debug(`Wrote XCTestConfiguration to ${remotePath}`);

        const readBack = await afcService.getFileContents(remotePath);
        expect(readBack).to.be.instanceOf(Buffer);
        expect(readBack.length).to.equal(plistData.length);

        const parsed = parseBinaryPlist(readBack);
        expect(parsed).to.have.property('$archiver', 'NSKeyedArchiver');
        expect(parsed).to.have.property('$version', 100000);
        expect(parsed).to.have.property('$objects').that.is.an('array');

        log.debug(
          'XCTestConfiguration round-trip verified: write → read → parse succeeded',
        );
      } finally {
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
      testmanagerdConnection = await Services.startTestmanagerdService(udid);
      dvtConnection = await Services.startDVTService(udid);

      log.debug('Connected to testmanagerd and DVT services');

      const controlChannel =
        await testmanagerdConnection.testmanagerdService.makeChannel(
          TESTMANAGERD_CHANNEL,
        );
      const channelCode = controlChannel.getCode();
      expect(channelCode).to.be.greaterThan(0);

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

      // iOS may return negative PIDs for suspended launch states.
      const pid = await dvtConnection.processControl.launch({
        bundleId: 'com.apple.calculator',
        killExisting: true,
      });
      expect(pid).to.be.a('number');
      expect(pid).to.not.equal(0);
      log.debug(`Launched Calculator with PID: ${pid}`);

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
      log.debug(
        'Successfully authorized test session for Calculator PID via testmanagerd',
      );

      const absPid = Math.abs(pid);
      try {
        await dvtConnection.processControl.kill(absPid);
        log.debug(`Killed Calculator (PID: ${absPid})`);
      } catch (error) {
        log.debug('Error killing calculator (may have already exited):', error);
      }
    });
  });

  describe('Full XCTest launch flow (xcodebuild replacement)', function () {
    const mochaTimeoutMs = Number(
      process.env.XCTEST_MOCHA_TIMEOUT_MS || 360000,
    );
    let installProxyConn: InstallationProxyServiceWithConnection | null = null;
    let houseArrestConn: HouseArrestServiceWithConnection | null = null;
    let controlConn: TestmanagerdServiceWithConnection | null = null;
    let execConn: TestmanagerdServiceWithConnection | null = null;
    let dvtConn: DVTServiceWithConnection | null = null;
    let launchedPid: number = 0;

    const testRunnerBundleId = process.env.TEST_RUNNER_BUNDLE_ID;
    const appUnderTestBundleId = process.env.APP_UNDER_TEST_BUNDLE_ID;
    const xctestBundleId = process.env.XCTEST_BUNDLE_ID;

    beforeEach(function () {
      this.timeout(mochaTimeoutMs);
    });

    before(function () {
      if (!testRunnerBundleId || !appUnderTestBundleId || !xctestBundleId) {
        this.skip();
      }
    });

    after(async function () {
      if (launchedPid && dvtConn) {
        try {
          await dvtConn.processControl.kill(Math.abs(launchedPid));
          log.debug(`Killed test runner (PID: ${Math.abs(launchedPid)})`);
        } catch {}
      }

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
      installProxyConn = await Services.startInstallationProxyService(udid);
      const lookupResult =
        await installProxyConn.installationProxyService.lookup(
          [testRunnerBundleId!],
          { returnAttributes: ['*'] },
        );

      const appInfo: AppInfo = lookupResult[testRunnerBundleId!];
      expect(appInfo, `App ${testRunnerBundleId} not found on device`).to.not.be
        .undefined;
      expect(appInfo.Path).to.be.a('string');

      const appPath = appInfo.Path!;
      const appContainer = appInfo.Container || '';
      const execName = (appInfo as any).CFBundleExecutable as string;
      expect(execName, 'CFBundleExecutable not found in app info').to.be.a(
        'string',
      );

      const targetName = resolveTargetName(execName);
      const xctestName = getXctestNameFromBundleId(xctestBundleId!);
      const targetAppBundleId = appUnderTestBundleId!;
      const targetLookup =
        await installProxyConn.installationProxyService.lookup(
          [targetAppBundleId],
          { returnAttributes: ['Path'] },
        );
      const targetAppPath = targetLookup[targetAppBundleId]?.Path;
      expect(
        targetAppPath,
        `Target app ${targetAppBundleId} not found on device`,
      ).to.be.a('string');

      log.debug(
        `App info: path=${appPath}, container=${appContainer}, exec=${execName}, target=${targetName}`,
      );

      const sessionId = crypto.randomUUID();
      const configFileName = `${xctestName}-${sessionId.toUpperCase()}.xctestconfiguration`;
      const configRelativePath = `/tmp/${configFileName}`;

      const encoder = new XCTestConfigurationEncoder();
      const archived = encoder.encodeXCTestConfiguration({
        testBundleURL: `file://${appPath}/PlugIns/${xctestName}.xctest`,
        sessionIdentifier: sessionId,
        targetApplicationBundleID: targetAppBundleId,
        targetApplicationPath: targetAppPath,
        initializeForUITesting: true,
        reportResultsToIDE: true,
        productModuleName: xctestName,
      });
      const configData = createBinaryPlist(archived);

      houseArrestConn = await Services.startHouseArrestService(udid);
      const afcService = await houseArrestConn.houseArrestService.vendContainer(
        testRunnerBundleId!,
      );

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

      execConn = await Services.startTestmanagerdService(udid);
      const execChannel =
        await execConn.testmanagerdService.makeChannel(TESTMANAGERD_CHANNEL);
      const execCode = execChannel.getCode();

      const execInitArgs = new MessageAux();
      execInitArgs.appendObj({ __type: 'NSUUID', uuid: sessionId });
      execInitArgs.appendObj({
        __type: 'XCTCapabilities',
        capabilities: DEFAULT_EXEC_CAPABILITIES,
      });

      await execConn.testmanagerdService.sendMessage(
        execCode,
        '_IDE_initiateSessionWithIdentifier:capabilities:',
        execInitArgs,
      );
      const [execResult] =
        await execConn.testmanagerdService.recvPlist(execCode);
      log.debug('Exec session init result:', execResult);

      dvtConn = await Services.startDVTService(udid);

      const testBundlePath = `${appPath}/PlugIns/${xctestName}.xctest`;
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
        XCTestConfigurationFilePath: configRelativePath,
        XCTestManagerVariant: 'DDI',
        XCTestSessionIdentifier: sessionId.toUpperCase(),
      };

      launchedPid = await dvtConn.processControl.launch({
        bundleId: testRunnerBundleId!,
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

      const configPayload = createBinaryPlist(archived);

      let testFinished = false;
      let listenerError: Error | null = null;
      const listenerAbort = new AbortController();

      const execCallbackListener = (async () => {
        while (!listenerAbort.signal.aborted) {
          const result =
            await execConn!.testmanagerdService.recvPlistWithTimeout(
              execCode,
              2000,
            );

          if (!result) {
            continue;
          }

          const [selector, auxiliaries] = result;

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

          if (
            typeof selector === 'string' &&
            selector.startsWith('_XCT_didFinishExecutingTestPlan')
          ) {
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
        }
      })();

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

      const planArgs = new MessageAux();
      planArgs.appendObj(XCODE_VERSION);

      await execConn!.testmanagerdService.sendMessage(
        -1,
        '_IDE_startExecutingTestPlanWithProtocolVersion:',
        planArgs,
        false,
      );
      log.debug('Test plan execution started');

      const maxWaitMs = Number(
        process.env.XCTEST_PLAN_TIMEOUT_MS ||
          Math.max(60000, mochaTimeoutMs - 30000),
      );
      const startTime = Date.now();
      while (!testFinished && Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      listenerAbort.abort();

      try {
        await execCallbackListener;
      } catch (err) {
        listenerError = err as Error;
      }

      if (listenerError) {
        throw new Error(
          `Exec callback listener failed: ${listenerError.message}`,
        );
      }

      expect(
        testFinished,
        `XCTest plan did not finish — no finish callback was received within ${maxWaitMs}ms`,
      ).to.be.true;

      log.info(
        '=== Full XCTest launch flow completed successfully without xcodebuild ===',
      );
      log.info(
        `Session: ${sessionId}, PID: ${absPid}, Runner: ${testRunnerBundleId}, XCTest: ${xctestBundleId}, Target: ${appUnderTestBundleId}`,
      );
    });
  });
});
