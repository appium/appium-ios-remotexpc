import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {type DeviceControlService} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the CoreDevice device-control service
 * (`com.apple.coredevice.devicecontrol`).
 *
 * Requires a physical iOS device with a running tunnel registry. These tests
 * physically rotate the device, then rotate back to restore the original
 * orientation (a 'left' step is undone by a 'right' step).
 */
describe('DeviceControlService', {timeout: 60000}, function () {
  let deviceControl: DeviceControlService | null = null;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();
    deviceControl = await Services.startDeviceControlService(udid);
  });

  after(async function () {
    try {
      await deviceControl?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('rotates the device and returns the resulting orientation', async function () {
    const state = await deviceControl!.rotate('left');
    assert.ok(typeof state === 'object' && state !== null && !Array.isArray(state));
    assert.ok(typeof state.currentDeviceOrientation === 'string');

    // Restore: 'right' undoes the 'left' step.
    await deviceControl!.rotate('right');
  });

  it('consecutive left rotations change the orientation', async function () {
    const first = await deviceControl!.rotate('left');
    const second = await deviceControl!.rotate('left');

    assert.ok(typeof first.currentDeviceOrientation === 'string');
    assert.ok(typeof second.currentDeviceOrientation === 'string');
    assert.notStrictEqual(second.currentDeviceOrientation, first.currentDeviceOrientation);

    // Restore: undo the two 'left' steps.
    await deviceControl!.rotate('right');
    await deviceControl!.rotate('right');
  });
});
