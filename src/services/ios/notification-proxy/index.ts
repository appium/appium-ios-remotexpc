import {getLogger} from '../../../lib/logger.js';
import type {
  NotificationProxyService as NotificationProxyServiceInterface,
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import {type ServiceConnection} from '../../../service-connection.js';
import {BaseService} from '../base-service.js';

const log = getLogger('NotificationProxyService');

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
class NotificationProxyService extends BaseService implements NotificationProxyServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.notification_proxy.shim.remote';
  private readonly timeout: number;
  private _conn: ServiceConnection | null = null;
  private _pendingNotificationsObservationSet: Set<string> = new Set();

  constructor(udid: string, timeout: number = 10000) {
    super(udid);
    this.timeout = timeout;
  }

  /**
   * Observe a notification
   *
   * `ObserveNotification` has no per-command acknowledgement on the wire (matching
   * notification_proxy's real protocol), so this only sends the request; it does not
   * wait for or return a device reply.
   * @param notification The notification name to subscribe to
   * @returns Promise that resolves once the subscription request has been sent
   */
  async observe(notification: string): Promise<PlistDictionary> {
    const conn = await this.connectToNotificationProxyService();
    conn.sendPlist(this.createObserveNotificationRequest(notification));
    this._pendingNotificationsObservationSet.add(notification);
    return {};
  }

  /**
   * Post a notification
   *
   * Like `ObserveNotification`, `PostNotification` has no per-command acknowledgement
   * on the wire, so this only sends the request; it does not wait for a device reply.
   * Waiting here would also race any concurrent `expectNotifications()`/`expectNotification()`
   * reader on the same connection for whatever message arrives next.
   * @param notification The notification name to post
   * @returns Promise that resolves once the post request has been sent
   */
  async post(notification: string): Promise<PlistDictionary> {
    if (!this._pendingNotificationsObservationSet.has(notification)) {
      log.error(
        'Posting notifications without observing them may not yield any results. ' +
          'Consider calling observe() first.',
      );
      throw new Error('You must call observe() before posting notifications.');
    }
    const conn = await this.connectToNotificationProxyService();
    conn.sendPlist(this.createPostNotificationRequest(notification));
    this._pendingNotificationsObservationSet.delete(notification);
    return {};
  }

  /**
   * Expect notifications as an async generator
   * @param timeout Timeout in milliseconds
   * @returns AsyncGenerator yielding PlistMessage objects
   */
  async *expectNotifications(timeout: number = 120000): AsyncGenerator<PlistMessage> {
    if (!this._conn) {
      this._conn = await this.connectToNotificationProxyService();
    }
    while (true) {
      try {
        const notification = await this._conn.receive(timeout);
        const notificationStr = JSON.stringify(notification);
        const truncatedStr = notificationStr.length > 500 ? `${notificationStr.substring(0, 500)}...` : notificationStr;
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
    const {value, done} = await generator.next();
    if (done || !value) {
      throw new Error('No notification received');
    }
    return value;
  }

  /**
   * Close the notification proxy service connection
   */
  close(): void {
    try {
      if (this._conn) {
        this._conn.close();
        log.debug('Notification proxy connection closed successfully');
      }
    } catch (error) {
      log.error('Error closing notification proxy connection:', error);
    } finally {
      this._conn = null;
      this._pendingNotificationsObservationSet.clear();
    }
  }

  /**
   * Connect to the notification proxy service
   *
   * Drains the shim's initial `StartService` greeting once, right after establishing a
   * new connection, so it can never be mistaken for the reply to a later request.
   * @returns Promise resolving to the ServiceConnection instance
   */
  async connectToNotificationProxyService(): Promise<ServiceConnection> {
    if (this._conn) {
      return this._conn;
    }
    const conn = await this.startLockdownService(NotificationProxyService.RSD_SERVICE_NAME, {
      createConnectionTimeout: this.timeout,
    });
    const greeting = await conn.receive(this.timeout);
    if (greeting?.Request !== 'StartService') {
      throw new Error(`Expected StartService greeting, got: ${JSON.stringify(greeting)}`);
    }
    this._conn = conn;
    return this._conn;
  }

  private createObserveNotificationRequest(notification: string): ObserveNotificationRequest {
    return {
      Command: 'ObserveNotification',
      Name: notification,
    };
  }

  private createPostNotificationRequest(notification: string): PostNotificationRequest {
    return {
      Command: 'PostNotification',
      Name: notification,
    };
  }
}

export {NotificationProxyService};
