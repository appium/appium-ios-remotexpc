import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../src/index.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('ProcessControl.test');

describe('ProcessControl Service', function () {
  this.timeout(60000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async function () {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  it('should have processControl service', function () {
    expect(dvtServiceConnection).to.not.be.null;
    expect(dvtServiceConnection!.processControl).to.not.be.null;
  });

  it('should get process identifier for system app (Settings)', async function () {
    // com.apple.Preferences is the bundle ID for Settings
    try {
      const pid =
        await dvtServiceConnection!.processControl.processIdentifierForBundleIdentifier(
          'com.apple.Preferences',
        );
      expect(pid).to.be.a('number');
      // pid can be -1 if not running
      log.debug(`Settings PID: ${pid}`);
    } catch (error) {
      log.error('Failed to get PID:', error);
      throw error;
    }
  });

  it('should launch an application (Calculator)', async function () {
    // com.apple.calculator
    try {
      const pid = await dvtServiceConnection!.processControl.launch({
        bundleId: 'com.apple.calculator',
        killExisting: true,
      });
      expect(pid).to.be.greaterThan(0);
      log.debug(`Launched Calculator PID: ${pid}`);

      // Allow some time for launch
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify it's running using DeviceInfo
      const isRunning =
        await dvtServiceConnection!.deviceInfo.isRunningPid(pid);
      expect(isRunning).to.be.true;

      // Clean up
      await dvtServiceConnection!.processControl.kill(pid);
    } catch (error) {
      log.error('Launch test failed:', error);
      throw error;
    }
  });

  it('should kill a launched process', async function () {
    try {
      // Launch Calculator again
      const pid = await dvtServiceConnection!.processControl.launch({
        bundleId: 'com.apple.calculator',
        killExisting: true,
      });
      expect(pid).to.be.greaterThan(0);

      // Kill it
      await dvtServiceConnection!.processControl.kill(pid);

      // Verify it's dead
      // Wait a moment for system to update
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const isRunning =
        await dvtServiceConnection!.deviceInfo.isRunningPid(pid);
      expect(isRunning).to.be.false;
    } catch (error) {
      log.error('Kill test failed:', error);
      throw error;
    }
  });
});
