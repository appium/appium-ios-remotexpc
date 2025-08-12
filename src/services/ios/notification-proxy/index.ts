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
 * - Receive notifications
 */
class NotificationProxyService
  extends BaseService
  implements NotificationProxyServiceInterface
{
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.notification_proxy.shim.remote';
  private readonly timeout: number;
  private _conn: ServiceConnection | null = null;
  private _observeNotificationCalled: Map<string, boolean> = new Map();

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
    this._observeNotificationCalled.set(notification, true);
    return result;
  }

  /**
   * Post a notification
   * @param notification The notification name to post
   * @returns Promise that resolves when the post request is sent
   */
  async post(notification: string): Promise<PlistDictionary> {
    if (!this._observeNotificationCalled.get(notification)) {
      log.error(
        'Posting notifications without observing them may not yield any results. ' +
          'Consider calling observe() first.',
      );
      throw new Error('You must call observe() before posting notifications.');
    }
    this._conn = await this.connectToNotificationProxyService();
    const request = this.createPostNotificationRequest(notification);
    const result = await this.sendPlistDictionary(request);
    this._observeNotificationCalled.delete(notification);
    return result;
  }

  /**
   * Receive notifications as an async generator
   */
  async *receiveNotification(
    timeout: number = 120000,
  ): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    while (true) {
      try {
        const notification = await this._conn.receive(timeout);
        log.info(`received response: ${JSON.stringify(notification)}`);
        yield notification;
      } catch (error) {
        log.error(`Error receiving notification: ${(error as Error).message}`);
        throw error;
      }
    }
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

  private getServiceConfig() {
    return {
      serviceName: NotificationProxyService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
      options: { createConnectionTimeout: this.timeout },
    };
  }
  private async sendPlistDictionary(request: PlistDictionary) {
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
