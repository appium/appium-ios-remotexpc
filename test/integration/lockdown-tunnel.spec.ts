import assert from 'node:assert/strict';
import {before, describe, it} from 'node:test';

import {createLockdownServiceForTunnel} from '../../src/index.js';
import type {LockdownDeviceInfo} from '../../src/lib/types.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration: tunnel lockdown (`createLockdownServiceForTunnel`) and `getDeviceInfo()`.
 *
 * **Prerequisites (same as other tunnel tests, e.g. AFC):**
 * - Active tunnel plus tunnel registry HTTP API (`tunnel-creation.mjs`, `start-appletv-tunnel.mjs`,
 *   or equivalent)
 * - **`UDID`** — device that has a tunnel entry in that registry.
 */

describe('Lockdown over tunnel (getDeviceInfo)', {timeout: 60000}, function () {
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();
  });

  it('should return lockdown device info', async function () {
    const lockdown = await createLockdownServiceForTunnel(udid);
    try {
      const info: LockdownDeviceInfo = await lockdown.getDeviceInfo();
      assert.ok(typeof info === 'object' && info !== null && !Array.isArray(info));
      assert.ok(typeof info.UniqueDeviceID === 'string');
      assert.ok(info.UniqueDeviceID.length > 0);
      assert.ok(typeof info.ProductVersion === 'string');
      assert.ok(info.ProductVersion.length > 0);
    } finally {
      lockdown.close();
    }
  });
});
