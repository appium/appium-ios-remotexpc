import { logger } from '@appium/support';
import { expect } from 'chai';

import type { WebInspectorService } from '../../src/lib/types.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('WebInspectorService.test');
log.level = 'debug';

describe('WebInspectorService', function () {
  this.timeout(60000);

  let service: WebInspectorService;
  let remoteXPC: any;
  const udid = process.env.UDID || '00008030-001E290A3EF2402E';
  const sessionId = 'test-session-' + Date.now();
  let realAppId: string | null = null;
  let realPageId: number | null = null;

  before(async function () {
    if (!udid) {
      throw new Error('Set UDID env var to execute tests.');
    }
    const result = await Services.startWebInspectorService(udid);
    service = result.webInspectorService;
    remoteXPC = result.remoteXPC;
  });

  after(async function () {
    if (service) {
      await service.close();
    }
    if (remoteXPC) {
      await remoteXPC.close();
    }
  });

  it('should connect and have valid connection ID', function () {
    expect(service).to.not.be.null;
    const connectionId = service.connectionId;
    expect(connectionId).to.be.a('string');
    expect(connectionId.length).to.be.greaterThan(0);
  });

  it('should send messages', async function () {
    await service.getConnectedApplications();
    await service.requestApplicationLaunch('com.apple.mobilesafari');
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it('should receive messages', async function () {
    const messages: any[] = [];

    await service.listenMessage((msg) => messages.push(msg));
    await service.getConnectedApplications();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(messages.length).to.be.greaterThan(0);
    expect(messages[0]).to.have.property('__selector');
    expect(messages[0]).to.have.property('__argument');

    service.stopListening();
  });

  describe('Safari Integration', function () {
    before(async function () {
      // Find Safari app and page
      const messages: any[] = [];
      let foundSafari = false;

      await service.listenMessage((message) => {
        messages.push(message);

        // Find Safari application
        if (message.__selector === '_rpc_reportConnectedApplicationList:') {
          const arg = message.__argument;
          if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && !Array.isArray(arg)) {
            const apps = (arg as any).WIRApplicationDictionaryKey;
            if (apps) {
              for (const [appId, appData] of Object.entries(apps)) {
                if ((appData as any).WIRApplicationBundleIdentifierKey === 'com.apple.mobilesafari') {
                  realAppId = appId;
                  foundSafari = true;
                }
              }
            }
          }
        }

        // Find Safari page
        if (message.__selector === '_rpc_applicationSentListing:' && realAppId) {
          const arg = message.__argument;
          if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && !Array.isArray(arg)) {
            const appId = (arg as any).WIRApplicationIdentifierKey;
            if (appId === realAppId) {
              const listing = (arg as any).WIRListingKey;
              if (listing) {
                const pageIds = Object.keys(listing);
                if (pageIds.length > 0) {
                  realPageId = parseInt(pageIds[0], 10);
                }
              }
            }
          }
        }
      });

      await service.getConnectedApplications();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (realAppId) {
        await service.forwardGetListing(realAppId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      service.stopListening();

      if (!foundSafari || !realAppId || !realPageId) {
        log.warn('Safari not found. Ensure Safari is open with a webpage loaded.');
        this.skip();
      }
    });

    it('should setup inspector socket', async function () {
      if (!realAppId || !realPageId) {
        this.skip();
        return;
      }

      const messages: any[] = [];
      await service.listenMessage((msg) => messages.push(msg));

      await service.forwardSocketSetup(sessionId, realAppId, realPageId, false);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(messages.length).to.be.greaterThan(0);
      service.stopListening();
    });

    it('should send CDP commands and receive responses', async function () {
      if (!realAppId || !realPageId) {
        this.skip();
        return;
      }

      const cdpResponses: any[] = [];

      await service.listenMessage((message) => {
        if (message.__selector === '_rpc_applicationSentData:') {
          const arg = message.__argument;
          if (arg && typeof arg === 'object' && !Buffer.isBuffer(arg) && !Array.isArray(arg)) {
            const dataKey = (arg as any).WIRMessageDataKey;
            if (dataKey) {
              try {
                const dataString = Buffer.isBuffer(dataKey) ? dataKey.toString('utf-8') : dataKey;
                cdpResponses.push(JSON.parse(dataString));
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
      });

      // Setup socket
      await service.forwardSocketSetup(sessionId, realAppId, realPageId, false);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Get target ID
      const targetEvent = cdpResponses.find((msg) => msg.method === 'Target.targetCreated');
      if (!targetEvent) {
        throw new Error('Target.targetCreated event not received');
      }

      const targetId = targetEvent.params?.targetInfo?.targetId;
      expect(targetId).to.be.a('string');

      // Send CDP command via Target.sendMessageToTarget
      await service.forwardSocketData(sessionId, realAppId, realPageId, {
        id: 100,
        method: 'Target.sendMessageToTarget',
        params: {
          targetId,
          message: JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression: '1 + 1', returnByValue: true },
          }),
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Parse nested responses
      const dispatchMessages = cdpResponses.filter(
        (msg) => msg.method === 'Target.dispatchMessageFromTarget'
      );

      expect(dispatchMessages.length).to.be.greaterThan(0);

      const nestedResponse = JSON.parse(dispatchMessages[0].params.message);
      expect(nestedResponse.result).to.exist;
      expect(nestedResponse.result.result.value).to.equal(2);

      service.stopListening();
    });

    it('should highlight webview on device', async function () {
      if (!realAppId || !realPageId) {
        this.skip();
        return;
      }

      const messages: any[] = [];
      await service.listenMessage((msg) => messages.push(msg));

      await service.forwardIndicateWebView(realAppId, realPageId, true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await service.forwardIndicateWebView(realAppId, realPageId, false);
      await new Promise((resolve) => setTimeout(resolve, 500));

      service.stopListening();
    });
  });

  it('should handle automation session request', async function () {
    const messages: any[] = [];
    await service.listenMessage((msg) => messages.push(msg));

    await service.forwardAutomationSessionRequest(
      'automation-session-' + Date.now(),
      'com.apple.mobilesafari',
    );

    await new Promise((resolve) => setTimeout(resolve, 1000));
    service.stopListening();
  });

  it('should stop and restart listening', async function () {
    let count = 0;
    await service.listenMessage(() => count++);

    await service.getConnectedApplications();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const firstCount = count;

    service.stopListening();
    await service.getConnectedApplications();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(count).to.equal(firstCount); // No new messages

    await service.listenMessage(() => count++);
    await service.getConnectedApplications();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(count).to.be.greaterThan(firstCount);
    service.stopListening();
  });
});
