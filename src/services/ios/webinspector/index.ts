import { logger } from '@appium/support';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import type { PlistDictionary, PlistMessage } from '../../../lib/types.js';
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
  private isReceiving: boolean = false;
  private readonly connectionId: string;
  private skipNextStartServiceMessage: boolean = false;

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
    const connection = await this.ensureConnected();

    // Add connection identifier to all messages
    const message: WebInspectorMessage = {
      __selector: selector,
      __argument: {
        ...args,
        WIRConnectionIdentifierKey: this.connectionId,
      },
    };

    log.debug(`Sending WebInspector message: ${selector}`);
    log.debug(`Message details: ${JSON.stringify(message, null, 2)}`);

    connection.sendPlist(message);
  }

  /**
   * Listen to messages from the WebInspector service
   * @param handler Handler function that will be called for each received message
   * @returns Promise that resolves when listening starts
   */
  async listenMessage(handler: (message: PlistMessage) => void): Promise<void> {
    await this.ensureConnected();

    this.messageEmitter.on('message', handler);

    // Start receiving messages in the background if not already receiving
    if (!this.isReceiving) {
      this.startMessageReceiver();
    }
  }

  /**
   * Stop listening to messages
   */
  stopListening(): void {
    this.isReceiving = false;
    this.messageEmitter.removeAllListeners('message');
    this.messageEmitter.removeAllListeners('error');
    log.debug('Stopped listening for WebInspector messages');
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
    const socketData = typeof data === 'string' ? data : JSON.stringify(data);

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

  /**
   * Connect to the WebInspector service
   * @returns Promise resolving to the ServiceConnection instance
   */
  private async ensureConnected(): Promise<ServiceConnection> {
    if (this.connection) {
      return this.connection;
    }

    const service = {
      serviceName: WebInspectorService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    this.connection = await this.startLockdownService(service);
    this.skipNextStartServiceMessage = true;

    // Send initial identifier report
    await this.sendMessage('_rpc_reportIdentifier:', {});

    log.debug('Connected to WebInspector service');
    return this.connection;
  }

  /**
   * Start receiving messages from the WebInspector service
   */
  private async startMessageReceiver(): Promise<void> {
    if (!this.connection) {
      throw new Error('Connection not established');
    }

    this.isReceiving = true;

    try {
      while (this.isReceiving) {
        const message = await this.connection.receive();

        // Skip the StartService response from RSDCheckin on new connections
        if (
          this.skipNextStartServiceMessage &&
          message &&
          typeof message === 'object' &&
          (message as any).Request === 'StartService'
        ) {
          this.skipNextStartServiceMessage = false;
          continue;
        }

        this.skipNextStartServiceMessage = false;
        this.messageEmitter.emit('message', message);
      }
    } catch (error) {
      if (this.isReceiving) {
        this.messageEmitter.emit('error', error);
      }
    }
  }
}

export default WebInspectorService;
