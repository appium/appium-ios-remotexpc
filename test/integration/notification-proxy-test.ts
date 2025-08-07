import * as Services from '../../src/services.js';
import { logger } from '@appium/support';

// Set NotificationProxyService logger to info level
logger.getLogger('NotificationProxyService').level = 'info';

describe('NotificationProxyService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let notificationProxyService: any;
  const udid = process.env.UDID || '00008110-001854423C3A801E';

  before(async function () {
    const result = await Services.startNotificationProxyService(udid);
    notificationProxyService = result.notificationProxyService;
    remoteXPC = result.remoteXPC;
  });

  after(async function () {
    if (remoteXPC) {
      try {
        await remoteXPC.close();
      } catch (error) {
        // Ignore cleanup errors in tests
      }
    }
  });

  it('prints notifications as they are received', async function () {
    await notificationProxyService.subscribe('com.apple.springboard.lockstate');
    const gen = notificationProxyService.receiveNotification();
    const { value: notification, done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    // eslint-disable-next-line no-console
    console.log('Received notification:', notification);
  });
});
