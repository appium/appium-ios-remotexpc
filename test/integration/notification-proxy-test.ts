import { logger } from '@appium/support';
import { expect } from 'chai';
import { after, before, describe, it } from 'node:test';

import type { NotificationProxyService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import { requireDeviceUdid } from './helpers/device.js';

const log = logger.getLogger('NotificationProxyService.test');
// Set NotificationProxyService logger to info level
log.level = 'info';

describe('NotificationProxyService', { timeout: 60000 }, function () {
  let notificationProxyService: NotificationProxyService;
  const udid = requireDeviceUdid();

  before(async function () {
    notificationProxyService =
      await Services.startNotificationProxyService(udid);
  });

  after(async function () {
    try {
      notificationProxyService?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('expect a single notification', async function () {
    try {
      await notificationProxyService.observe('com.apple.springboard.lockstate');
      const notification = await notificationProxyService.expectNotification();
      log.debug('Received notification:', notification);
      expect(notification).to.be.an('object');
    } catch (error) {
      log.error('Error receiving notification:', (error as Error).message);
      throw error;
    }
  });

  it('expect notifications from generator', async function () {
    await notificationProxyService.observe('com.apple.springboard.lockstate');
    const gen = notificationProxyService.expectNotifications();
    const { value: notification, done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    for await (const msg of gen) {
      log.debug('Received notification:', msg);
      expect(msg).to.be.an('object');
    } // Keep the generator running to receive more notifications
  });

  it('observe and post notifications', async function () {
    const notificationName = 'com.apple.springboard.lockstate';
    await notificationProxyService.observe(notificationName);
    const gen = notificationProxyService.expectNotifications();
    const { value: notification, done: done } = await gen.next();
    if (done || !notification) {
      throw new Error('No notification received.');
    }
    const post = await notificationProxyService.post(notificationName);
    if (post.Name !== notificationName) {
      throw new Error(
        `Expected post notification to be ${notificationName}, but got ${post.Name}`,
      );
    }
    expect(post).to.be.an('object');
    log.debug('Received post notification:', post);
  });

  it('error if post called first', async function () {
    const notificationName = 'com.apple.springboard.lockstate';
    try {
      await notificationProxyService.post(notificationName);
      // If we reach here, the post didn't throw an error as expected
      throw new Error(
        'Expected post() to throw an error when called before observe()',
      );
    } catch (error) {
      // Verify the error is the expected one
      if (error instanceof Error) {
        expect(error.message).to.equal(
          'You must call observe() before posting notifications.',
        );
      } else {
        throw new Error('Unexpected error type');
      }
    }
  });
});
