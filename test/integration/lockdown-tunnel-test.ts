import { expect } from 'chai';

import { Services, createLockdownServiceByTunnel } from '../../src/index.js';
import type { RemoteXpcConnection } from '../../src/lib/remote-xpc/remote-xpc-connection.js';
import type { LockdownDeviceInfo } from '../../src/lib/types.js';

/**
 * Integration: tunnel lockdown (`createLockdownServiceByTunnel`) and `getDeviceInfo()`.
 *
 * **Prerequisites (same as other tunnel tests, e.g. AFC):**
 * - Active tunnel plus tunnel registry HTTP API (`tunnel-creation.mjs`, `start-appletv-tunnel.mjs`,
 *   or equivalent)
 * - **`UDID`** — device that has a tunnel entry in that registry.
 */

describe('Lockdown over tunnel (getDeviceInfo)', function () {
  this.timeout(60000);

  const udid = process.env.UDID?.trim() ?? '';

  let remoteXPC: RemoteXpcConnection | undefined;

  before(async function () {
    if (!udid) {
      this.skip();
    }
    const { remoteXPC: rx } = await Services.createRemoteXPCConnection(udid);
    remoteXPC = rx;
  });

  after(async function () {
    try {
      await remoteXPC?.close();
    } catch {
      // ignore
    }
  });

  it('should return lockdown device info', async function () {
    if (!udid || !remoteXPC) {
      this.skip();
    }

    const lockdown = await createLockdownServiceByTunnel(remoteXPC, udid);
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
