import { logger } from '@appium/support';
import { expect } from 'chai';

import type { WebInspectorService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

describe('WebInspectorService Integration', function () {
  this.timeout(60000);

  let serviceWithConnection: {
    webInspectorService: WebInspectorService;
    remoteXPC: any;
  } | null = null;
  const testUdid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async function () {
    if (!testUdid) {
      throw new Error('set UDID env var to execute tests.');
    }

    // Establish connection for all tests
    serviceWithConnection = await Services.startWebInspectorService(testUdid);
  });

  after(async function () {
    if (serviceWithConnection) {
      // Close the service first
      await serviceWithConnection.webInspectorService.close();
      
      // Then close the RemoteXPC connection
      if (serviceWithConnection.remoteXPC) {
        await serviceWithConnection.remoteXPC.close();
      }
    }
  });

  describe('Service Connection', () => {
    it('should connect to WebInspector service', async function () {
      expect(serviceWithConnection).to.not.be.null;
      expect(serviceWithConnection!.webInspectorService).to.not.be.null;
      expect(serviceWithConnection!.remoteXPC).to.not.be.null;
    });

    it('should have a valid connection ID', function () {
      const connectionId =
        serviceWithConnection!.webInspectorService.getConnectionId();
      expect(connectionId).to.be.a('string');
      expect(connectionId.length).to.be.greaterThan(0);
      log.debug(`Connection ID: ${connectionId}`);
    });
  });

  describe('Send Message Operations', () => {
    it('should send _rpc_reportIdentifier message', async function () {
      // This message is automatically sent during connection, but we can send it again
      await serviceWithConnection!.webInspectorService.sendMessage(
        '_rpc_reportIdentifier:',
        {},
      );
      // No error means success - WebInspector uses fire-and-forget for sending
    });

    it('should send _rpc_getConnectedApplications message', async function () {
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      // Wait a bit for the device to respond
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    it('should send _rpc_requestApplicationLaunch message', async function () {
      // Launch Safari
      await serviceWithConnection!.webInspectorService.requestApplicationLaunch(
        'com.apple.mobilesafari',
      );
      // Wait a bit for the device to respond
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });
  });

  describe('Listen Message Operations', () => {
    it('should receive messages from WebInspector', async function () {
      const receivedMessages: any[] = [];
      let messageCount = 0;
      const maxMessages = 3;

      await serviceWithConnection!.webInspectorService.requestApplicationLaunch(
        'com.apple.mobilesafari',
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));


      // Start listening for messages
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          log.debug(`Received message ${messageCount + 1}:`, message);
          receivedMessages.push(message);
          messageCount++;
        },
      );

      // Request connected applications to trigger some messages
      await serviceWithConnection!.webInspectorService.getConnectedApplications();

      // Wait for messages to arrive
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (messageCount >= maxMessages) {
            clearInterval(checkInterval);
            resolve(undefined);
          }
        }, 100);

        // Timeout after 15 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(undefined);
        }, 15000);
      });

      log.info(`Received ${messageCount} messages`);
      expect(receivedMessages.length).to.be.greaterThan(0);

      // Verify message structure
      receivedMessages.forEach((msg, index) => {
        expect(msg).to.be.an('object');
        log.debug(`Message ${index + 1} type:`, Object.keys(msg));
      });

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });

    it('should handle messages with __selector and __argument', async function () {
      const receivedMessages: any[] = [];
      let reportCurrentStateReceived = false;

      // Listen for specific message types
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);

          // Check if this is a _rpc_reportCurrentState message
          if (message.__selector === '_rpc_reportCurrentState:') {
            reportCurrentStateReceived = true;
            log.debug('Received _rpc_reportCurrentState message');
            log.debug('Message argument:', message.__argument);
          }
        },
      );

      // Request identifier to trigger a current state report
      await serviceWithConnection!.webInspectorService.sendMessage(
        '_rpc_reportIdentifier:',
        {},
      );

      // Wait for the response
      await new Promise((resolve) => setTimeout(resolve, 3000));

      log.info(`Received ${receivedMessages.length} messages total`);

      // We should have received at least the current state message
      expect(receivedMessages.length).to.be.greaterThan(0);

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Application and Page Operations', () => {
    it('should send forwardGetListing for an application', async function () {
      // First, get connected applications
      const receivedMessages: any[] = [];
      let appId: string | null = null;

      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);

          // Look for connected application list
          if (message.__selector === '_rpc_reportConnectedApplicationList:') {
            const argument = message.__argument;
            if (argument && typeof argument === 'object' && !Buffer.isBuffer(argument) && !Array.isArray(argument)) {
              const apps = (argument as any).WIRApplicationDictionaryKey;
              if (apps && typeof apps === 'object') {
                // Get the first app ID
                const appIds = Object.keys(apps);
                if (appIds.length > 0) {
                  appId = appIds[0];
                  log.debug(`Found application ID: ${appId}`);
                }
              }
            }
          }
        },
      );

      // Request connected applications
      await serviceWithConnection!.webInspectorService.getConnectedApplications();

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (appId) {
        // Try to get listing for the app
        await serviceWithConnection!.webInspectorService.forwardGetListing(
          appId,
        );
        log.debug('Successfully sent forwardGetListing request');

        // Wait for listing response
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        log.warn('No applications found to test forwardGetListing');
      }

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Advanced Operations', () => {
    it('should handle forwardSocketSetup message', async function () {
      const sessionId = 'test-session-' + Date.now();
      const appId = 'test-app-id';
      const pageId = 1;

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardSocketSetup(
          sessionId,
          appId,
          pageId,
          true,
        );
        log.debug('forwardSocketSetup message sent successfully');
      } catch (error) {
        log.warn(
          `forwardSocketSetup failed (expected without real app): ${(error as Error).message}`,
        );
      }
    });

    it('should handle forwardSocketData message', async function () {
      const sessionId = 'test-session-' + Date.now();
      const appId = 'test-app-id';
      const pageId = 1;
      const testData = { method: 'Runtime.enable', id: 1 };

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardSocketData(
          sessionId,
          appId,
          pageId,
          testData,
        );
        log.debug('forwardSocketData message sent successfully');
      } catch (error) {
        log.warn(
          `forwardSocketData failed (expected without real session): ${(error as Error).message}`,
        );
      }
    });

    it('should handle forwardIndicateWebView message', async function () {
      const appId = 'test-app-id';
      const pageId = 1;

      // This will likely fail on a real device without a proper app/page,
      // but it tests that the message can be sent
      try {
        await serviceWithConnection!.webInspectorService.forwardIndicateWebView(
          appId,
          pageId,
          true,
        );
        log.debug('forwardIndicateWebView message sent successfully');
      } catch (error) {
        log.warn(
          `forwardIndicateWebView failed (expected without real app): ${(error as Error).message}`,
        );
      }
    });
  });

  describe('Automation Session', () => {
    it('should handle forwardAutomationSessionRequest', async function () {
      const sessionId = 'automation-session-' + Date.now();
      const appId = 'com.apple.mobilesafari';

      // Listen for responses
      const receivedMessages: any[] = [];
      await serviceWithConnection!.webInspectorService.listenMessage(
        (message) => {
          receivedMessages.push(message);
          log.debug('Received response:', message.__selector);
        },
      );

      // Send automation session request
      try {
        await serviceWithConnection!.webInspectorService.forwardAutomationSessionRequest(
          sessionId,
          appId,
        );
        log.debug('forwardAutomationSessionRequest sent successfully');

        // Wait for responses
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        log.warn(
          `forwardAutomationSessionRequest failed: ${(error as Error).message}`,
        );
      }

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });

  describe('Message Listener Management', () => {
    it('should allow stopping and restarting listening', async function () {
      let messageCount = 0;

      // Start listening
      await serviceWithConnection!.webInspectorService.listenMessage(() => {
        messageCount++;
      });

      // Send a message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const countAfterFirst = messageCount;
      expect(countAfterFirst).to.be.greaterThan(0);

      // Stop listening
      serviceWithConnection!.webInspectorService.stopListening();

      // Send another message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Message count should not have increased
      expect(messageCount).to.equal(countAfterFirst);

      // Restart listening
      await serviceWithConnection!.webInspectorService.listenMessage(() => {
        messageCount++;
      });

      // Send another message
      await serviceWithConnection!.webInspectorService.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Message count should have increased
      expect(messageCount).to.be.greaterThan(countAfterFirst);

      // Clean up
      serviceWithConnection!.webInspectorService.stopListening();
    });
  });
});
