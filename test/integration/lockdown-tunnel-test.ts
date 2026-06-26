import { createLockdownServiceForTunnel } from '../../src/index.js';
import type { LockdownDeviceInfo } from '../../src/lib/types.js';

/**
 * Integration: tunnel lockdown (`createLockdownServiceForTunnel`) and `getDeviceInfo()`.
 *
 * **Prerequisites (same as other tunnel tests, e.g. AFC):**
 * - Active tunnel plus tunnel registry HTTP API (`tunnel-creation.mjs`, `start-appletv-tunnel.mjs`,
 *   or equivalent)
 * - **`UDID`** — device that has a tunnel entry in that registry.
 */

describe('Lockdown over tunnel (getDeviceInfo)', function () {
  this.timeout(60000);

  const udid = process.env.UDID?.trim() ?? '';

  it('should return lockdown device info', async function () {
    if (!udid) {
      this.skip();
    }

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
});
