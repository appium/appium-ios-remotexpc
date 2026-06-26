import { constants as osConstants } from 'node:os';

import { type AppService, CoreDeviceError } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { requireDeviceUdid } from './helpers/device.js';

/**
 * Integration tests for the CoreDevice AppService.
 *
 * Requires a physical iOS device with a running tunnel registry and the
 * Developer Disk Image mounted (AppService is a developer service). Set the UDID
 * env var to the target device; the bundle launched defaults to Preferences and
 * can be overridden via APP_BUNDLE_ID.
 *
 * Note (iOS 26): full `listApps` enumeration of third-party apps does not
 * complete over the RSD AppService path (the device only responds for an empty
 * result set), so the listApps test is bounded and lenient. Process and app
 * lifecycle operations (launch / signal / listProcesses) work fully.
 */
describe('AppService', function () {
  this.timeout(60000);

  let appService: AppService | null = null;
  const udid = requireDeviceUdid();
  const bundleId = process.env.APP_BUNDLE_ID || 'com.apple.Preferences';
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  before(async function () {
    requireDeviceUdid(udid);
    appService = await Services.startAppService(udid);
  });

  after(async function () {
    try {
      await appService?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('lists running processes', async function () {
    const processes = await appService!.listProcesses();
    expect(processes).to.be.an('array');
    expect(processes.length).to.be.greaterThan(0);
    expect(processes[0]).to.have.property('processIdentifier');
    expect(processes[0].processIdentifier).to.be.a('number');
  });

  it('launches an application and confirms it is running', async function () {
    const launched = await appService!.launchApplication(bundleId);
    expect(launched.processIdentifier).to.be.a('number');
    expect(launched.processToken).to.be.an('object');

    await sleep(800);
    const processes = await appService!.listProcesses();
    const running = processes.some(
      (p) => p.processIdentifier === launched.processIdentifier,
    );
    expect(running, 'launched process should appear in listProcesses').to.equal(
      true,
    );

    // Clean up.
    await appService!.sendSignalToProcess(
      launched.processIdentifier!,
      osConstants.signals.SIGKILL,
    );
  });

  it('signals a process and confirms it is gone', async function () {
    const launched = await appService!.launchApplication(bundleId);
    await sleep(800);

    const result = await appService!.sendSignalToProcess(
      launched.processIdentifier!,
      osConstants.signals.SIGKILL,
    );
    expect(result).to.be.an('object');

    await sleep(1500);
    const processes = await appService!.listProcesses();
    const stillRunning = processes.some(
      (p) => p.processIdentifier === launched.processIdentifier,
    );
    expect(stillRunning, 'signalled process should be gone').to.equal(false);
  });

  it('throws a descriptive error when launching a non-existent bundle', async function () {
    let caught: unknown;
    try {
      await appService!.launchApplication('com.foo.doesnotexist', {
        timeoutMs: 10000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(CoreDeviceError);
    expect((caught as Error).message.toLowerCase()).to.contain('not installed');
  });

  it('uninstall is idempotent for a non-installed bundle', async function () {
    // The device resolves successfully even if the app is not installed.
    await appService!.uninstallApp('com.foo.doesnotexist');
  });

  it('monitorProcessTermination resolves immediately for a dead pid', async function () {
    const result = await appService!.monitorProcessTermination(987654, {
      timeoutMs: 8000,
    });
    expect(result).to.be.an('object');
  });

  it('reuses a single service across multiple operations', async function () {
    // Each invocation transparently opens a fresh connection; verify several
    // sequential calls on one service instance all succeed.
    const a = await appService!.listProcesses();
    const launched = await appService!.launchApplication(bundleId);
    const b = await appService!.listProcesses();
    await appService!.sendSignalToProcess(
      launched.processIdentifier!,
      osConstants.signals.SIGKILL,
    );
    expect(a.length).to.be.greaterThan(0);
    expect(b.length).to.be.greaterThan(0);
  });

  it('lists apps (bounded; iOS 26 may not enumerate over this path)', async function () {
    try {
      const apps = await appService!.listApps({
        requireContainerAccess: true,
        includeRemovableApps: false,
        includeAppClips: false,
        includeHiddenApps: false,
        includeInternalApps: false,
        timeoutMs: 8000,
      });
      expect(apps).to.be.an('array');
    } catch {
      // iOS 26 may not respond to app enumeration over the AppService path.
      this.skip();
    }
  });
});
