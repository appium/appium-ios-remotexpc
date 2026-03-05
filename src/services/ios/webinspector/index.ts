import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { getLogger } from '../../../lib/logger.js';
import type { PlistDictionary, PlistMessage } from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = getLogger('WebInspectorService');

/**
 * Interface for WebInspector message structure
 */
export interface WebInspectorMessage extends PlistDictionary {
  __selector: string;
  __argument: PlistDictionary;
}

/**
 * WebInspectorService provides an API to:
 * - Send messages to webinspector
 * - Listen to messages from webinspector
 * - Communicate with web views and Safari on iOS devices
 *
 * This service is used for web automation, inspection, and debugging.
 */
export class WebInspectorService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.webinspector.shim.remote';

  // RPC method selectors
  private static readonly RPC_REPORT_IDENTIFIER = '_rpc_reportIdentifier:';
  private static readonly RPC_REQUEST_APPLICATION_LAUNCH =
    '_rpc_requestApplicationLaunch:';
  private static readonly RPC_GET_CONNECTED_APPLICATIONS =
    '_rpc_getConnectedApplications:';
  private static readonly RPC_FORWARD_GET_LISTING = '_rpc_forwardGetListing:';
  private static readonly RPC_FORWARD_AUTOMATION_SESSION_REQUEST =
    '_rpc_forwardAutomationSessionRequest:';
  private static readonly RPC_FORWARD_SOCKET_SETUP = '_rpc_forwardSocketSetup:';
  private static readonly RPC_FORWARD_SOCKET_DATA = '_rpc_forwardSocketData:';
  private static readonly RPC_FORWARD_INDICATE_WEB_VIEW =
    '_rpc_forwardIndicateWebView:';

  private connection: ServiceConnection | null = null;
  private _connectionPromise: Promise<ServiceConnection> | null = null;
  private messageEmitter: EventEmitter = new EventEmitter();
  private isReceiving: boolean = false;
  private readonly connectionId: string;
  private receivePromise: Promise<void> | null = null;

  constructor(address: [string, number]) {
    super(address);
    this.connectionId = randomUUID().toUpperCase();
  }

  /**
   * Send a message to the WebInspector service
   * @param selector The RPC selector (e.g., '_rpc_reportIdentifier:')
   * @param args The arguments dictionary for the message
   * @returns Promise that resolves when the message is sent
   */
  async sendMessage(
    selector: string,
    args: PlistDictionary = {},
  ): Promise<void> {
    const connection = await this.connectToWebInspectorService();

    // Add connection identifier to all messages
    const message: WebInspectorMessage = {
      __selector: selector,
      __argument: {
        ...args,
        WIRConnectionIdentifierKey: this.connectionId,
      },
    };

    log.debug(`Sending WebInspector message: ${selector}`);

    connection.sendPlist(message);
  }

  /**
   * Listen to messages from the WebInspector service using async generator
   * @yields PlistMessage - Messages received from the WebInspector service
   */
  async *listenMessage(): AsyncGenerator<PlistMessage, void, unknown> {
    await this.connectToWebInspectorService();

    // Start receiving messages in background if not already started
    if (!this.isReceiving) {
      this.startMessageReceiver();
    }

    const queue: PlistMessage[] = [];
    let resolveNext: ((value: IteratorResult<PlistMessage>) => void) | null =
      null;
    let stopped = false;

    const messageHandler = (message: PlistMessage) => {
      if (resolveNext) {
        resolveNext({ value: message, done: false });
        resolveNext = null;
      } else {
        queue.push(message);
      }
    };

    const stopHandler = () => {
      stopped = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    };

    this.messageEmitter.on('message', messageHandler);
    this.messageEmitter.once('stop', stopHandler);

    try {
      while (!stopped) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          const message = await new Promise<PlistMessage | null>((resolve) => {
            if (stopped) {
              resolve(null);
              return;
            }
            resolveNext = (result) => {
              resolve(result.done ? null : result.value);
            };
          });

          if (message === null) {
            break;
          }

          yield message;
        }
      }
    } finally {
      this.messageEmitter.off('message', messageHandler);
      this.messageEmitter.off('stop', stopHandler);
    }
  }

  /**
   * Stop listening to messages
   * @Deprecated Use stopListeningAsync() instead for connecting with multiple connections
   */
  stopListening(): void {
    this.isReceiving = false;
    this.messageEmitter.emit('stop');
  }

  /**
   * Stop listening to messages
   */
  async stopListeningAsync(): Promise<void> {
    this.isReceiving = false;
    this.messageEmitter.emit('stop');

    // Wait for the background receiver to finish
    if (this.receivePromise) {
      await this.receivePromise;
      this.receivePromise = null;
    }

    // Remove all listeners to prevent memory leaks and ensure clean restart
    this.messageEmitter.removeAllListeners('message');
    this.messageEmitter.removeAllListeners('stop');
  }

  /**
   * Close the connection and clean up resources
   */
  async close(): Promise<void> {
    await this.stopListeningAsync();

    this._connectionPromise = null;

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      log.debug('WebInspector connection closed');
    }
  }

  /**
   * Get the connection ID being used for this service
   * @returns The connection identifier
   */
  getConnectionId(): string {
    return this.connectionId;
  }

  /**
   * Request application launch
   * @param bundleId The bundle identifier of the application to launch
   */
  async requestApplicationLaunch(bundleId: string): Promise<void> {
    await this.sendMessage(WebInspectorService.RPC_REQUEST_APPLICATION_LAUNCH, {
      WIRApplicationBundleIdentifierKey: bundleId,
    });
  }

  /**
   * Get connected applications
   */
  async getConnectedApplications(): Promise<void> {
    await this.sendMessage(
      WebInspectorService.RPC_GET_CONNECTED_APPLICATIONS,
      {},
    );
  }

  /**
   * Forward get listing for an application
   * @param appId The application identifier
   */
  async forwardGetListing(appId: string): Promise<void> {
    await this.sendMessage(WebInspectorService.RPC_FORWARD_GET_LISTING, {
      WIRApplicationIdentifierKey: appId,
    });
  }

  /**
   * Forward automation session request
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param capabilities Optional session capabilities
   */
  async forwardAutomationSessionRequest(
    sessionId: string,
    appId: string,
    capabilities?: PlistDictionary,
  ): Promise<void> {
    const defaultCapabilities: PlistDictionary = {
      'org.webkit.webdriver.webrtc.allow-insecure-media-capture': true,
      'org.webkit.webdriver.webrtc.suppress-ice-candidate-filtering': false,
    };

    await this.sendMessage(
      WebInspectorService.RPC_FORWARD_AUTOMATION_SESSION_REQUEST,
      {
        WIRApplicationIdentifierKey: appId,
        WIRSessionIdentifierKey: sessionId,
        WIRSessionCapabilitiesKey: {
          ...defaultCapabilities,
          ...(capabilities ?? {}),
        },
      },
    );
  }

  /**
   * Forward socket setup for inspector connection
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param automaticallyPause Whether to automatically pause (defaults to true)
   */
  async forwardSocketSetup(
    sessionId: string,
    appId: string,
    pageId: number,
    automaticallyPause: boolean = true,
  ): Promise<void> {
    const message: PlistDictionary = {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSenderKey: sessionId,
      WIRMessageDataTypeChunkSupportedKey: 0,
    };

    if (!automaticallyPause) {
      message.WIRAutomaticallyPause = false;
    }

    await this.sendMessage(
      WebInspectorService.RPC_FORWARD_SOCKET_SETUP,
      message,
    );
  }

  /**
   * Forward socket data to a page
   * @param sessionId The session identifier
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param data The data to send (will be JSON stringified)
   */
  async forwardSocketData(
    sessionId: string,
    appId: string,
    pageId: number,
    data: any,
  ): Promise<void> {
    const socketData = typeof data === 'string' ? data : JSON.stringify(data);

    await this.sendMessage(WebInspectorService.RPC_FORWARD_SOCKET_DATA, {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRSessionIdentifierKey: sessionId,
      WIRSenderKey: sessionId,
      WIRSocketDataKey: Buffer.from(socketData, 'utf-8'),
    });
  }

  /**
   * Forward indicate web view
   * @param appId The application identifier
   * @param pageId The page identifier
   * @param enable Whether to enable indication
   */
  async forwardIndicateWebView(
    appId: string,
    pageId: number,
    enable: boolean,
  ): Promise<void> {
    await this.sendMessage(WebInspectorService.RPC_FORWARD_INDICATE_WEB_VIEW, {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRIndicateEnabledKey: enable,
    });
  }

  /**
   * Connect to the WebInspector service.
   * @returns Promise resolving to the ServiceConnection instance
   */
  private async connectToWebInspectorService(): Promise<ServiceConnection> {
    // Fast path: already connected
    if (this.connection) {
      return Promise.resolve(this.connection);
    }

    // Slow path: serialize concurrent callers behind a single promise so only
    // one TCP connection is ever created.
    if (!this._connectionPromise) {
      this._connectionPromise = this._doConnect();
    }
    return this._connectionPromise;
  }

  /**
   * Performs the actual connection setup. Should only be called once; all
   * subsequent callers should await the cached _connectionPromise.
   */
  private async _doConnect(): Promise<ServiceConnection> {
    const service = {
      serviceName: WebInspectorService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    try {
      const connection = await this.startLockdownService(service);
      this.connection = connection;

      // Consume the StartService response from RSDCheckin so it does not reach the message
      // handler as an "invalid plist". Continue if nothing is received within 500ms.
      try {
        const extra = await connection.receive(500);
        if (extra) {
          log.debug(
            `Consumed post-checkin response during connection setup: ${JSON.stringify(extra)}`,
          );
        }
      } catch {
        // Timeout is normal when the device does not send a post-checkin response
      }

      // Send the initial connection identifier.
      // NOTE: setConnectionKey() in the appium-remote-debugger connect mixin also
      // sends _rpc_reportIdentifier:.  Sending it here as well is intentional:
      // it is the established handshake sequence for the shim protocol.
      await this.sendMessage(WebInspectorService.RPC_REPORT_IDENTIFIER, {});

      log.debug('Connected to WebInspector service');
      return connection;
    } catch (err) {
      // Reset on failure so that the next call will try again.
      this._connectionPromise = null;
      this.connection = null;
      throw err;
    }
  }

  /**
   * Start receiving messages from the WebInspector service in the background
   */
  private startMessageReceiver(): void {
    if (this.isReceiving || !this.connection) {
      return;
    }

    this.isReceiving = true;

    this.receivePromise = (async () => {
      try {
        while (this.isReceiving && this.connection) {
          try {
            const message = await this.connection.receive();
            this.messageEmitter.emit('message', message);
          } catch (error) {
            if (!this.isReceiving) {
              log.debug('Message receiver stopped during receive operation');
              break;
            }

            // Check if it's a timeout error (expected when no messages are arriving)
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('Timed out waiting for plist response')) {
              // Normal - just continue waiting for more messages
              log.debug(
                'No messages received in the last second, continuing to listen...',
              );
              continue;
            }

            // For other errors, log and exit
            log.error('Error receiving message:', error);
            this.messageEmitter.emit('error', error);
            break;
          }
        }
        log.debug('Message receiver loop exited cleanly');
      } finally {
        this.isReceiving = false;
      }
    })();
  }
}

export default WebInspectorService;
