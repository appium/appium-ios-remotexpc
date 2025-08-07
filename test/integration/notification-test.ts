import { expect } from 'chai';

import { Services } from '../../src/index.js';
import type { NotificationProxyService } from '../../src/lib/types.js';

describe('Notification Proxy Service', function () {
  // Increase timeout for integration tests
  this.timeout(60000);

  let remoteXPC: any;
  let notificationProxyService: NotificationProxyService;
  const udid = process.env.UDID || '00008030-000318693E32402E';

  before(async function () {
    ({ notificationProxyService, remoteXPC } =
      await Services.startNotificationProxyService(udid));
  });

  after(async function () {
    // Close RemoteXPC connection
    if (remoteXPC) {
      try {
       // await remoteXPC.close();
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

   it('Observe notification', async function () {
    const conn = await notificationProxyService.connectToNotificationProxyService(100000000000);
    const lockInfo = await conn.sendPlistRequest({
      Command: 'ObserveNotification',
      Name: 'com.apple.system.config.network_change',
      // com.apple.bluetooth.state
      // com.apple.system.config.network_change
    });
    console.log('Received notification:', lockInfo);
    expect(lockInfo).to.be.an('object');
  });
});
