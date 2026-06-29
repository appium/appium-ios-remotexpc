import { expect } from 'chai';
import { describe, it } from 'node:test';

import { createLockdownServiceForTunnel } from '../../src/index.js';
import type { LockdownDeviceInfo } from '../../src/lib/types.js';
import { requireDeviceUdid } from './helpers/device.js';

/**
 * Integration: tunnel lockdown (`createLockdownServiceForTunnel`) and `getDeviceInfo()`.
 *
 * **Prerequisites (same as other tunnel tests, e.g. AFC):**
 * - Active tunnel plus tunnel registry HTTP API (`tunnel-creation.mjs`, `start-appletv-tunnel.mjs`,
 *   or equivalent)
 * - **`UDID`** — device that has a tunnel entry in that registry.
 */

describe(
  'Lockdown over tunnel (getDeviceInfo)',
  { timeout: 60000 },
  function () {
    const udid = requireDeviceUdid();

    it('should return lockdown device info', async function () {
      const lockdown = await createLockdownServiceForTunnel(udid);
      try {
        const info: LockdownDeviceInfo = await lockdown.getDeviceInfo();
        expect(info).to.be.an('object');
        expect(info.UniqueDeviceID).to.be.a('string').and.not.empty;
        expect(info.ProductVersion).to.be.a('string').and.not.empty;
      } finally {
        lockdown.close();
      }
    });
  },
);
