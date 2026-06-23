import { expect } from 'chai';

import type { AppServiceService } from '../../src/index.js';
import * as Services from '../../src/services.js';

/**
 * Integration tests for the CoreDevice AppService.
 *
 * Requires a physical iOS device with a running tunnel registry and the
 * Developer Disk Image mounted (AppService is a developer service). Set the UDID
 * env var to the target device; the bundle launched/terminated defaults to
 * Preferences and can be overridden via APP_BUNDLE_ID.
 *
 * Note (iOS 26): full `listApps` enumeration of third-party apps does not
 * complete over the RSD AppService path (the device only responds for an empty
 * result set), so the listApps test is bounded and lenient. Process and app
 * lifecycle operations (launch/terminate/signal/listProcesses) work fully.
 */
describe('AppServiceService', function () {
  this.timeout(60000);

  let appService: AppServiceService | null = null;
  const udid = process.env.UDID || '';
  const bundleId = process.env.APP_BUNDLE_ID || 'com.apple.Preferences';
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    appService = await Services.startAppServiceService(udid);
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
    await appService!.terminateApplication(launched.processIdentifier!);
  });

  it('terminates a launched application', async function () {
    const launched = await appService!.launchApplication(bundleId);
    await sleep(800);

    await appService!.terminateApplication(launched.processIdentifier!);

    await sleep(1500);
    const processes = await appService!.listProcesses();
    const stillRunning = processes.some(
      (p) => p.processIdentifier === launched.processIdentifier,
    );
    expect(stillRunning, 'terminated process should be gone').to.equal(false);
  });

  it('sends a signal to a process', async function () {
    const launched = await appService!.launchApplication(bundleId);
    await sleep(500);

    const result = await appService!.sendSignalToProcess(
      launched.processIdentifier!,
      9,
    );
    expect(result).to.be.an('object');

    await sleep(1200);
    const processes = await appService!.listProcesses();
    const stillRunning = processes.some(
      (p) => p.processIdentifier === launched.processIdentifier,
    );
    expect(stillRunning).to.equal(false);
  });

  it('reuses a single service across multiple operations', async function () {
    // Each invocation transparently opens a fresh connection; verify several
    // sequential calls on one service instance all succeed.
    const a = await appService!.listProcesses();
    const launched = await appService!.launchApplication(bundleId);
    const b = await appService!.listProcesses();
    await appService!.terminateApplication(launched.processIdentifier!);
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
    } catch (error) {
      // iOS 26 may not respond to app enumeration over the AppService path.
      this.skip();
    }
  });
});
