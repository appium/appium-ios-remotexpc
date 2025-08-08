import { logger } from '@appium/support';
import type { NotificationProxyService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import { expect } from 'chai';

// Set NotificationProxyService logger to info level
logger.getLogger('NotificationProxyService').level = 'info';

describe('NotificationProxyService', function () {
  this.timeout(60000);

  let remoteXPC: any;
  let notificationProxyService: NotificationProxyService;
  const udid = process.env.UDID || '';

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

  it('print a notification as it is received', async function () {
    await notificationProxyService.observe('com.apple.springboard.lockstate');
    const gen = notificationProxyService.receive_notification();
    const { value: notification, done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    // eslint-disable-next-line no-console
    console.log('Received notification:', notification);
  });

  it('prints all notifications as they are received', async function () {
    await notificationProxyService.observe('com.apple.springboard.lockstate');
    const gen = notificationProxyService.receive_notification();
    const { value: notification, done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    for await (const msg of gen) {
      // eslint-disable-next-line no-console
      console.log('Received notification:', msg);
    } // Keep the generator running to receive more notifications
  });

  it('observe and post notifications', async function() {
    const notificationName = 'com.apple.springboard.lockstate';
    await notificationProxyService.observe(notificationName);
    const gen = notificationProxyService.receive_notification();
    const { value: notification, done: done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    const post = await notificationProxyService.post(notificationName);
    if (post.Name !== notificationName) {
      throw new Error(`Expected post notification to be ${notificationName}, but got ${post.Name}`);
    }
    // eslint-disable-next-line no-console
    console.log('Received post notification:', post);

  });

  it('error if post called first', async function () {
    const notificationName = 'com.apple.springboard.lockstate';
    try {
      await notificationProxyService.post(notificationName);
      // If we reach here, the post didn't throw an error as expected
      throw new Error('Expected post() to throw an error when called before observe()');
    } catch (error) {
      // Verify the error is the expected one
      if (error instanceof Error) {
        expect(error.message).to.equal('You must call observe() before posting notifications.');
      } else {
        throw new Error('Unexpected error type');
      }
    }
  });
});
