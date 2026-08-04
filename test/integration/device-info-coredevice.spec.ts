import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {CoreDeviceError, type CoreDeviceInfoService} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the CoreDevice DeviceInfo service
 * (`com.apple.coredevice.deviceinfo`).
 *
 * Requires a physical iOS device with a running tunnel registry. Set the UDID
 * env var to the target device.
 *
 * Note: `getLockState` is not implemented on some iOS versions
 * (`CoreDevice.ActionError 2`) and `queryMobileGestalt` is gated on most
 * devices (`CoreDevice.ActionError 5`), so those tests accept either a result
 * or a descriptive {@link CoreDeviceError}.
 */
describe('CoreDeviceInfoService', {timeout: 60000}, function () {
  let service: CoreDeviceInfoService | null = null;

  before(async function () {
    const udid = requireDeviceUdid();
    service = await Services.startCoreDeviceInfoService(udid);
  });

  after(async function () {
    try {
      await service?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('getDeviceInfo returns device attributes', async function () {
    const info = await service!.getDeviceInfo();
    assert.ok(typeof info === 'object' && info !== null && !Array.isArray(info));
    assert.ok(Object.keys(info).length > 0);
  });

  it('getDisplayInfo returns the primary display geometry', async function () {
    const display = await service!.getDisplayInfo();
    const displays = display.displays as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(displays), 'displays array');
    assert.ok(displays.length > 0, 'displays array');

    const primary = displays.find((d) => d.primary === true) ?? displays[0];
    const nativeSize = primary.nativeSize as number[];
    assert.ok(Array.isArray(nativeSize), 'primary nativeSize');
    assert.strictEqual(nativeSize.length, 2, 'primary nativeSize');
    assert.ok(nativeSize[0] > 0);
    assert.ok(nativeSize[1] > 0);
  });

  it('getLockState resolves or reports a clear CoreDevice error', async function () {
    // Not implemented on some iOS versions (CoreDevice.ActionError 2).
    try {
      const lock = await service!.getLockState({timeoutMs: 10000});
      assert.ok(typeof lock === 'object' && lock !== null && !Array.isArray(lock));
    } catch (error) {
      assert.ok(error instanceof CoreDeviceError);
    }
  });

  it('queryMobileGestalt resolves or reports a clear CoreDevice error', async function () {
    // Gated on most devices (CoreDevice.ActionError 5).
    try {
      const result = await service!.queryMobileGestalt(['ProductType'], {
        timeoutMs: 10000,
      });
      assert.ok(typeof result === 'object' && result !== null && !Array.isArray(result));
    } catch (error) {
      assert.ok(error instanceof CoreDeviceError);
    }
  });
});
