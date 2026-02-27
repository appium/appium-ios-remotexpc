import { logger } from '@appium/support';
import { expect } from 'chai';

import type {
  DVTServiceWithConnection,
  HouseArrestServiceWithConnection,
  TestmanagerdServiceWithConnection,
} from '../../src/index.js';
import { XCTestConfigurationEncoder, runXCTest } from '../../src/index.js';
import {
  createBinaryPlist,
  parseBinaryPlist,
} from '../../src/lib/plist/index.js';
import * as Services from '../../src/services.js';
import { MessageAux } from '../../src/services/ios/dvt/index.js';
import type { AppInfo } from '../../src/services/ios/installation-proxy/types.js';
import { TESTMANAGERD_CHANNEL } from '../../src/services/ios/testmanagerd/xcuitest.js';

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
    const testRunnerBundleId = process.env.TEST_RUNNER_BUNDLE_ID;
    const appUnderTestBundleId = process.env.APP_UNDER_TEST_BUNDLE_ID;
    const xctestBundleId = process.env.XCTEST_BUNDLE_ID;

    before(function () {
      if (!testRunnerBundleId || !appUnderTestBundleId || !xctestBundleId) {
        this.skip();
      }
    });

    it('should execute full XCTest launch lifecycle via runXCTest', async function () {
      this.timeout(Number(process.env.XCTEST_MOCHA_TIMEOUT_MS || 360000));

      const result = await runXCTest({
        udid,
        testRunnerBundleId: testRunnerBundleId!,
        appUnderTestBundleId: appUnderTestBundleId!,
        xctestBundleId: xctestBundleId!,
        timeoutMs: Number(process.env.XCTEST_PLAN_TIMEOUT_MS || 300000),
      });

      expect(result.status).to.equal('passed');
      expect(result.sessionIdentifier).to.be.a('string');
      expect(result.testRunnerPid).to.be.greaterThan(0);
      expect(result.durationMs).to.be.greaterThan(0);
    });
  });
});
