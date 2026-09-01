import assert from 'node:assert/strict';
import {type TestContext, after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {DVTInstruments} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('DeviceInfo.test');
log.level = 'debug';

describe('DeviceInfo Instrument', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async () => {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
    }
  });

  describe('File System Operations', () => {
    it('should list directory contents', async () => {
      const entries = await dvtServiceConnection!.deviceInfo.ls('/usr');

      assert.ok(Array.isArray(entries));
      assert.ok(entries.length > 0);
      assert.ok(entries.includes('bin'));
    });
  });

  describe('Process Management', () => {
    it('should get list of running processes', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();

      assert.ok(Array.isArray(processes));
      assert.ok(processes.length > 0);

      const firstProcess = processes[0];
      assert.ok('pid' in firstProcess);
      assert.ok(typeof firstProcess.pid === 'number');
    });

    it('should find SpringBoard process', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      assert.ok(springboard !== null && springboard !== undefined);
      assert.ok(typeof springboard!.pid === 'number');
    });

    it('should check if process is running', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const firstProcess = processes[0];

      const isRunning = await dvtServiceConnection!.deviceInfo.isRunningPid(firstProcess.pid);

      assert.strictEqual(isRunning, true);
    });

    it('should get executable name for PID', async function (ctx: TestContext) {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      if (springboard) {
        const execPath = await dvtServiceConnection!.deviceInfo.execnameForPid(springboard.pid);

        assert.ok(typeof execPath === 'string');
        assert.ok(execPath.length > 0);
        assert.ok(execPath.includes('SpringBoard'));
      } else {
        ctx.skip();
      }
    });
  });

  describe('System Information', () => {
    it('should get hardware information', async () => {
      const hwInfo = await dvtServiceConnection!.deviceInfo.hardwareInformation();

      assert.ok(typeof hwInfo === 'object' && hwInfo !== null && !Array.isArray(hwInfo));
      assert.ok(Object.keys(hwInfo).length > 0);
    });

    it('should get network information', async () => {
      const netInfo = await dvtServiceConnection!.deviceInfo.networkInformation();

      assert.ok(typeof netInfo === 'object' && netInfo !== null && !Array.isArray(netInfo));
      assert.ok(Object.keys(netInfo).length > 0);
    });

    it('should get mach time info', async () => {
      const timeInfo = await dvtServiceConnection!.deviceInfo.machTimeInfo();

      assert.ok(Array.isArray(timeInfo));
      assert.ok(timeInfo.length > 0);
    });

    it('should get mach kernel name', async () => {
      const kernelName = await dvtServiceConnection!.deviceInfo.machKernelName();

      assert.ok(typeof kernelName === 'string');
      assert.ok(kernelName.length > 0);
    });
  });

  describe('Performance and Debugging Information', () => {
    it('should get kpep database', async () => {
      const kpepDb = await dvtServiceConnection!.deviceInfo.kpepDatabase();

      if (kpepDb !== null) {
        assert.ok(typeof kpepDb === 'object' && kpepDb !== null && !Array.isArray(kpepDb));
        assert.ok(Object.keys(kpepDb).length > 0);
      }
    });

    it('should get trace codes', async () => {
      const codes = await dvtServiceConnection!.deviceInfo.traceCodes();

      assert.ok(typeof codes === 'object' && codes !== null && !Array.isArray(codes));
      assert.ok(Object.keys(codes).length > 0);

      const firstCode = Object.keys(codes)[0];
      assert.ok(typeof firstCode === 'string');
      assert.ok(typeof codes[firstCode] === 'string');
    });
  });

  describe('User and Group Information', () => {
    it('should get username for UID', async () => {
      // UID 0 is always root on iOS devices
      const username = await dvtServiceConnection!.deviceInfo.nameForUid(0);

      assert.ok(typeof username === 'string');
      assert.ok(username.length > 0);
    });

    it('should get group name for GID', async function (ctx: TestContext) {
      try {
        // mobile (501) is the common app-owner group on iOS
        const groupName = await dvtServiceConnection!.deviceInfo.nameForGid(501);

        assert.ok(typeof groupName === 'string');
        assert.ok(groupName.length > 0);
      } catch (error) {
        const message = (error as Error).message;
        // Apple dropped nameForGID: from DTDeviceInfoService
        if (message.includes('nameForGID') && message.includes('does not respond')) {
          ctx.skip();
          return;
        }
        throw error;
      }
    });
  });

  describe('Integration Tests', () => {
    it('should correlate process info with executable path', async function (ctx: TestContext) {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      if (springboard) {
        const execPath = await dvtServiceConnection!.deviceInfo.execnameForPid(springboard.pid);
        const isRunning = await dvtServiceConnection!.deviceInfo.isRunningPid(springboard.pid);

        assert.strictEqual(isRunning, true);
        assert.ok(typeof execPath === 'string');
        assert.ok(execPath.includes('SpringBoard'));
        assert.ok(typeof springboard.pid === 'number');
      } else {
        ctx.skip();
      }
    });
  });
});
