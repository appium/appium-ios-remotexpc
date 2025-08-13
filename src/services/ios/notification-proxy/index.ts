import { logger } from '@appium/support';

import type {
  NotificationProxyService as NotificationProxyServiceInterface,
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('NotificationProxyService');

export interface ObserveNotificationRequest extends PlistDictionary {
  Command: 'ObserveNotification';
  Name: string;
}

export interface PostNotificationRequest extends PlistDictionary {
  Command: 'PostNotification';
  Name: string;
}

/**
 * NotificationProxyService provides an API to:
 * - Observe notifications
 * - Post notifications
 * - Expects notifications
 */
class NotificationProxyService
  extends BaseService
  implements NotificationProxyServiceInterface
{
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.notification_proxy.shim.remote';
  private readonly timeout: number;
  private _conn: ServiceConnection | null = null;
  private _pendingNotificationsObservationSet: Set<string> = new Set();

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
    const request = this.createObserveNotificationRequest(notification);
    const result = await this.sendPlistDictionary(request);
    this._pendingNotificationsObservationSet.add(notification);
    return result;
  }

  /**
   * Post a notification
   * @param notification The notification name to post
   * @returns Promise that resolves when the post request is sent
   */
  async post(notification: string): Promise<PlistDictionary> {
    if (!this._pendingNotificationsObservationSet.has(notification)) {
      log.error(
        'Posting notifications without observing them may not yield any results. ' +
          'Consider calling observe() first.',
      );
      throw new Error('You must call observe() before posting notifications.');
    }
    this._conn = await this.connectToNotificationProxyService();
    const request = this.createPostNotificationRequest(notification);
    const result = await this.sendPlistDictionary(request);
    this._pendingNotificationsObservationSet.delete(notification);
    return result;
  }

  /**
   * Expect notifications as an async generator
   * @param timeout Timeout in milliseconds
   * @returns AsyncGenerator yielding PlistMessage objects
   */
  async *expectNotifications(
    timeout: number = 120000,
  ): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    while (true) {
      try {
        const notification = await this._conn.receive(timeout);
        const notificationStr = JSON.stringify(notification);
        const truncatedStr =
          notificationStr.length > 500
            ? `${notificationStr.substring(0, 500)}...`
            : notificationStr;
        log.info(`received response: ${truncatedStr}`);
        yield notification;
      } catch (error) {
        log.error(`Error receiving notification: ${(error as Error).message}`);
        throw error;
      }
    }
  }

  /**
   * Expect a single notification
   * @param timeout Timeout in milliseconds
   * @returns Promise resolving to the expected notification
   */
  async expectNotification(timeout: number = 120000): Promise<PlistMessage> {
    const generator = this.expectNotifications(timeout);
    const { value, done } = await generator.next();
    if (done || !value) {
      throw new Error('No notification received');
    }
    return value;
  }

  /**
   * Connect to the notification proxy service
   * @returns Promise resolving to the ServiceConnection instance
   */
  async connectToNotificationProxyService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }
    const service = this.getServiceConfig();
    this._conn = await this.startLockdownService(service);
    return this._conn;
  }

  private createObserveNotificationRequest(
    notification: string,
  ): ObserveNotificationRequest {
    return {
      Command: 'ObserveNotification',
      Name: notification,
    };
  }

  private createPostNotificationRequest(
    notification: string,
  ): PostNotificationRequest {
    return {
      Command: 'PostNotification',
      Name: notification,
    };
  }

  private getServiceConfig(): {
    serviceName: string;
    port: string;
    options: { createConnectionTimeout: number };
  } {
    return {
      serviceName: NotificationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: this.timeout },
    };
  }
  private async sendPlistDictionary(
    request: PlistDictionary,
  ): Promise<PlistDictionary> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    const response = await this._conn.sendPlistRequest(request, this.timeout);
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
