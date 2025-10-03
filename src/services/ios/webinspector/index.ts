import { logger } from '@appium/support';
import { EventEmitter } from 'events';

import type {
  PlistDictionary,
  PlistMessage,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

const log = logger.getLogger('WebInspectorService');

/**
 * Interface for WebInspector message structure
 */
export interface WebInspectorMessage extends PlistDictionary {
  __selector: string;
  __argument: PlistDictionary;
}

/**
 * WebInspectorService provides an API to:
 * - Send messages to webinspectord
 * - Listen to messages from webinspectord
 * - Communicate with web views and Safari on iOS devices
 * 
 * This service is used for web automation, inspection, and debugging.
 */
export class WebInspectorService extends BaseService {
  static readonly RSD_SERVICE_NAME = 'com.apple.webinspector.shim.remote';

  private connection: ServiceConnection | null = null;
  private messageEmitter: EventEmitter = new EventEmitter();
  private isListening: boolean = false;
  private connectionId: string;

  constructor(address: [string, number]) {
    super(address);
    // Generate a unique connection identifier (uppercase UUID format)
    this.connectionId = this.generateConnectionId();
  }

  /**
   * Generate a unique connection identifier in uppercase UUID format
   * @returns Connection ID string
   */
  private generateConnectionId(): string {
    // Generate UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
      .replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      })
      .toUpperCase();
  }

  /**
   * Connect to the WebInspector service
   * @returns Promise resolving to the ServiceConnection instance
   */
  private async connectToWebInspectorService(): Promise<ServiceConnection> {
    if (this.connection) {
      return this.connection;
    }

    const service = this.getServiceConfig();
    this.connection = await this.startLockdownService(service);

    // Send initial identifier report
    await this.reportIdentifier();

    log.debug('Connected to WebInspector service');
    return this.connection;
  }

  /**
   * Get the service configuration
   * @returns Service configuration object
   */
  private getServiceConfig() {
    return {
      serviceName: WebInspectorService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };
  }

  /**
   * Report identifier to the WebInspector service
   * This is the initial handshake message
   */
  private async reportIdentifier(): Promise<void> {
    await this.sendMessage('_rpc_reportIdentifier:', {});
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
    if (!this.connection) {
      await this.connectToWebInspectorService();
    }

    // Add connection identifier to all messages
    const messageArgs: PlistDictionary = {
      ...args,
      WIRConnectionIdentifierKey: this.connectionId,
    };

    const message: WebInspectorMessage = {
      __selector: selector,
      __argument: messageArgs,
    };

    log.debug(`Sending WebInspector message: ${selector}`);
    log.debug(`Message details: ${JSON.stringify(message, null, 2)}`);

    // WebInspector uses a fire-and-forget pattern for sending messages
    // We need to use a helper method to send without waiting for response
    await this.sendWebInspectorMessage(message);
  }

  /**
   * Listen to messages from the WebInspector service
   * @param callback Callback function that will be called for each received message
   * @returns Promise that resolves when listening starts
   */
  async listenMessage(
    callback: (message: PlistMessage) => void,
  ): Promise<void> {
    if (!this.connection) {
      await this.connectToWebInspectorService();
    }

    if (this.isListening) {
      log.warn('Already listening for messages');
      return;
    }

    this.isListening = true;
    this.messageEmitter.on('message', callback);

    // Start receiving messages in the background
    this.startMessageReceiver();
  }

  /**
   * Start receiving messages from the WebInspector service
   */
  private async startMessageReceiver(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      while (this.isListening) {
        try {
          const message = await this.connection.receive();

          const messageStr = JSON.stringify(message);
          const truncatedStr =
            messageStr.length > 500
              ? `${messageStr.substring(0, 500)}...`
              : messageStr;
          log.debug(`Received WebInspector message: ${truncatedStr}`);

          // Emit the message to all listeners
          this.messageEmitter.emit('message', message);
        } catch (error) {
          if (this.isListening) {
            log.error(
              `Error receiving WebInspector message: ${(error as Error).message}`,
            );
          }
          break;
        }
      }
    } catch (error) {
      log.error(
        `Message receiver error: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Stop listening to messages
   */
  stopListening(): void {
    this.isListening = false;
    this.messageEmitter.removeAllListeners('message');
    log.debug('Stopped listening for WebInspector messages');
  }

  /**
   * Send a WebInspector message without waiting for response
   * @param message The message to send
   */
  private async sendWebInspectorMessage(
    message: WebInspectorMessage,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error('Connection not established');
    }
    
    // Access the underlying PlistService through the protected method
    const plistService = (this.connection as any).getPlistService();
    if (!plistService) {
      throw new Error('PlistService not available');
    }
    
    // Send the message using the PlistService's sendPlist method
    plistService.sendPlist(message);
  }

  /**
   * Close the connection and clean up resources
   */
  async close(): Promise<void> {
    this.stopListening();

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

  // Convenience methods for common WebInspector operations

  /**
   * Request application launch
   * @param bundleId The bundle identifier of the application to launch
   */
  async requestApplicationLaunch(bundleId: string): Promise<void> {
    await this.sendMessage('_rpc_requestApplicationLaunch:', {
      WIRApplicationBundleIdentifierKey: bundleId,
    });
  }

  /**
   * Get connected applications
   */
  async getConnectedApplications(): Promise<void> {
    await this.sendMessage('_rpc_getConnectedApplications:', {});
  }

  /**
   * Forward get listing for an application
   * @param appId The application identifier
   */
  async forwardGetListing(appId: string): Promise<void> {
    await this.sendMessage('_rpc_forwardGetListing:', {
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

    await this.sendMessage('_rpc_forwardAutomationSessionRequest:', {
      WIRApplicationIdentifierKey: appId,
      WIRSessionIdentifierKey: sessionId,
      WIRSessionCapabilitiesKey: capabilities || defaultCapabilities,
    });
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

    await this.sendMessage('_rpc_forwardSocketSetup:', message);
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
    const socketData =
      typeof data === 'string' ? data : JSON.stringify(data);

    await this.sendMessage('_rpc_forwardSocketData:', {
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
    await this.sendMessage('_rpc_forwardIndicateWebView:', {
      WIRApplicationIdentifierKey: appId,
      WIRPageIdentifierKey: pageId,
      WIRIndicateEnabledKey: enable,
    });
  }
}

export default WebInspectorService;
