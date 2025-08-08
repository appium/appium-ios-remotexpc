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
    try {
      const conn = await this.connectToNotificationProxyService();
      const request: PlistDictionary = {
        Command: 'ObserveNotification',
        Name: notification,
      };
      this._observeNotificationCalled = true;
      return await conn.sendPlistRequest(request, this.timeout);
    } catch (error) {
      log.error(`Error subscribing to notification "${notification}": ${error}`);
      throw error;
    }
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
    try {
      const request: PlistDictionary = {
        Command: 'PostNotification',
        Name: notification,
      };
      return await this.sendRequest(request);
    } catch (error) {
      log.error(`Error posting notification "${notification}": ${error}`);
      throw error;
    }
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

  /**
   * Alias for interface compatibility: receive_notification (snake_case)
   */
  async *receive_notification(): AsyncGenerator<PlistMessage> {
    for await (const msg of this.receiveNotification()) {
      yield msg;
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

  private async sendRequest(
    request: PlistDictionary,
    timeout?: number,
  ): Promise<PlistDictionary> {
    const conn = await this.connectToNotificationProxyService();
    const response = await conn.sendPlistRequest(request, timeout ?? this.timeout);

    log.debug(`${request.Command} response received`);

    if (!response) {
      return {};
    }

    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }

    return response as PlistDictionary;
  }
}

export { NotificationProxyService };
