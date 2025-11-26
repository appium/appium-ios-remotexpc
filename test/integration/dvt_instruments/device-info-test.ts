import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../../src/index.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('DeviceInfo.test');
log.level = 'debug';

describe('DeviceInfo Instrument', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  describe('File System Operations', () => {
    it('should list directory contents', async () => {
      const entries = await dvtServiceConnection!.deviceInfo.ls('/usr');

      expect(entries).to.be.an('array');
      expect(entries.length).to.be.greaterThan(0);
      expect(entries).to.include('bin');
    });
  });

  describe('Process Management', () => {
    it('should get list of running processes', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();

      expect(processes).to.be.an('array');
      expect(processes.length).to.be.greaterThan(0);

      const firstProcess = processes[0];
      expect(firstProcess).to.have.property('pid');
      expect(firstProcess.pid).to.be.a('number');
    });

    it('should find SpringBoard process', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      expect(springboard).to.exist;
      expect(springboard!.pid).to.be.a('number');
    });

    it('should check if process is running', async () => {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const firstProcess = processes[0];

      const isRunning = await dvtServiceConnection!.deviceInfo.isRunningPid(
        firstProcess.pid,
      );

      expect(isRunning).to.be.true;
    });

    it('should get executable name for PID', async function () {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      if (springboard) {
        const execPath = await dvtServiceConnection!.deviceInfo.execnameForPid(
          springboard.pid,
        );

        expect(execPath).to.be.a('string');
        expect(execPath.length).to.be.greaterThan(0);
        expect(execPath).to.include('SpringBoard');
      } else {
        this.skip();
      }
    });
  });

  describe('System Information', () => {
    it('should get hardware information', async () => {
      const hwInfo =
        await dvtServiceConnection!.deviceInfo.hardwareInformation();

      expect(hwInfo).to.be.an('object');
      expect(Object.keys(hwInfo).length).to.be.greaterThan(0);
    });

    it('should get network information', async () => {
      const netInfo =
        await dvtServiceConnection!.deviceInfo.networkInformation();

      expect(netInfo).to.be.an('object');
      expect(Object.keys(netInfo).length).to.be.greaterThan(0);
    });

    it('should get mach time info', async () => {
      const timeInfo = await dvtServiceConnection!.deviceInfo.machTimeInfo();

      expect(timeInfo).to.be.an('array');
      expect(timeInfo.length).to.be.greaterThan(0);
    });

    it('should get mach kernel name', async () => {
      const kernelName =
        await dvtServiceConnection!.deviceInfo.machKernelName();

      expect(kernelName).to.be.a('string');
      expect(kernelName.length).to.be.greaterThan(0);
    });
  });

  describe('Performance and Debugging Information', () => {
    it('should get kpep database', async () => {
      const kpepDb = await dvtServiceConnection!.deviceInfo.kpepDatabase();

      if (kpepDb !== null) {
        expect(kpepDb).to.be.an('object');
        expect(Object.keys(kpepDb).length).to.be.greaterThan(0);
      }
    });

    it('should get trace codes', async () => {
      const codes = await dvtServiceConnection!.deviceInfo.traceCodes();

      expect(codes).to.be.an('object');
      expect(Object.keys(codes).length).to.be.greaterThan(0);

      const firstCode = Object.keys(codes)[0];
      expect(firstCode).to.be.a('string');
      expect(codes[firstCode]).to.be.a('string');
    });
  });

  describe('User and Group Information', () => {
    it('should get username for UID', async () => {
      // UID 0 is always root on iOS devices
      const username = await dvtServiceConnection!.deviceInfo.nameForUid(0);

      expect(username).to.be.a('string');
      expect(username.length).to.be.greaterThan(0);
    });

    it('should get group name for GID', async () => {
      // GID 0 is always wheel on iOS devices
      const groupName = await dvtServiceConnection!.deviceInfo.nameForGid(0);

      expect(groupName).to.be.a('string');
      expect(groupName.length).to.be.greaterThan(0);
    });
  });

  describe('Integration Tests', () => {
    it('should correlate process info with executable path', async function () {
      const processes = await dvtServiceConnection!.deviceInfo.proclist();
      const springboard = processes.find((p) => p.name === 'SpringBoard');

      if (springboard) {
        const execPath = await dvtServiceConnection!.deviceInfo.execnameForPid(
          springboard.pid,
        );
        const isRunning = await dvtServiceConnection!.deviceInfo.isRunningPid(
          springboard.pid,
        );

        expect(isRunning).to.be.true;
        expect(execPath).to.be.a('string');
        expect(execPath).to.include('SpringBoard');
        expect(springboard.pid).to.be.a('number');
      }
    });
  });
});
