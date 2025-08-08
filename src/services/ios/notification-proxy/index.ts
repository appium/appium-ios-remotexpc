import { logger } from '@appium/support';

import type {
  NotificationProxyService as NotificationProxyServiceInterface,
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('NotificationProxyService');

/**
 * NotificationProxyService provides an API to:
 * - Observe notifications
 * - Post notifications
 * - Receive notifications
 */
class NotificationProxyService
  extends BaseService
  implements NotificationProxyServiceInterface
{
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.notification_proxy.shim.remote';
  private readonly timeout: number;
  private _conn: any = null;
  private _observeNotificationCalled: boolean = false;

  constructor(address: [string, number], timeout: number = 10000) {
    super(address);
    this.timeout = timeout;
  }

  /**
   * Observe a notification
   * @param notification The notification name to subscribe to
   * @returns Promise that resolves when the subscription request is sent
   */
  async observe(notification: string): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    const request: PlistDictionary = {
      Command: 'ObserveNotification',
      Name: notification,
    };
    const response = await this._conn.sendPlistRequest(request, this.timeout);
    if (!response) {
      return {};
    }
    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }
    this._observeNotificationCalled = true;
    return response as PlistDictionary;
  }

  /**
   * Post a notification
   * @param notification The notification name to post
   * @returns Promise that resolves when the post request is sent
   */
  async post(notification: string): Promise<PlistDictionary> {
    if (!this._observeNotificationCalled) {
      log.error(
        'Posting notifications without observing them may not yield any results. ' +
          'Consider calling observe() first.',
      );
      throw new Error(
        'You must call observe() before posting notifications.',
      );
    }
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    const request: PlistDictionary = {
      Command: 'PostNotification',
      Name: notification,
    };
    const response = await this._conn.sendPlistRequest(request, this.timeout);
    if (!response) {
      return {};
    }
    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }
    return response as PlistDictionary;
  }

  /**
   * Receive notifications as an async generator
   */
  async *receiveNotification(): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    while (true) {
      try {
        const notification = await this._conn.receive(120000);
        log.info(`received response: ${JSON.stringify(notification)}`);
        yield notification;
      } catch (error) {
        log.error(`Error receiving notification: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  async connectToNotificationProxyService() {
    if (this._conn) {
      return this._conn;
    }
    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  private getServiceConfig() {
    return {
      serviceName: NotificationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: this.timeout },
    };
  }
}

export { NotificationProxyService };
