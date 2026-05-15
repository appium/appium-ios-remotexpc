import { expect } from 'chai';
import * as sinon from 'sinon';

import { RemoteXpcConnection } from '../../../src/lib/remote-xpc/remote-xpc-connection.js';
import {
  TunnelManager,
  rsdSessionLockKey,
} from '../../../src/lib/tunnel/index.js';

describe('TunnelManager RSD session lock', function () {
  it('serializes overlapping discovery sessions on the same tunnel endpoint', async function () {
    const lockKey = rsdSessionLockKey('fd00::1', 12345);
    const order: string[] = [];

    const connectStub = sinon
      .stub(TunnelManager, 'connectRemoteXPCUnlocked')
      .callsFake(async () => {
        order.push('connect-start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('connect-end');
        return {
          close: async () => {
            order.push('close');
          },
        } as unknown as RemoteXpcConnection;
      });

    const first = TunnelManager.runSerializedRsdSession(lockKey, async () => {
      const conn = await TunnelManager.connectRemoteXPCUnlocked(
        'fd00::1',
        12345,
      );
      order.push('session-a-mid');
      await conn.close();
      return 'a';
    });

    const second = TunnelManager.runSerializedRsdSession(lockKey, async () => {
      const conn = await TunnelManager.connectRemoteXPCUnlocked(
        'fd00::1',
        12345,
      );
      order.push('session-b-mid');
      await conn.close();
      return 'b';
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).to.equal('a');
    expect(b).to.equal('b');

    expect(order.indexOf('session-b-mid')).to.be.greaterThan(
      order.indexOf('close'),
      'second session should not start until the first has closed',
    );
    expect(order.filter((e) => e === 'connect-start')).to.have.lengthOf(2);

    connectStub.restore();
  });
});
