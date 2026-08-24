import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import WebInspectorService from '../../../src/services/ios/webinspector/index.js';

describe('WebInspectorService', function () {
  describe('listenMessage', function () {
    it('should throw receive errors to the consumer instead of crashing the process', async function () {
      const service = new WebInspectorService('test-udid');
      const receiveError = new Error('socket lost');

      const fakeConnection = {
        receive: async (): Promise<never> => {
          throw receiveError;
        },
      };
      (service as unknown as {connection: unknown}).connection = fakeConnection;

      await assert.rejects(async () => {
        for await (const _ of service.listenMessage()) {
          // no messages expected
        }
      }, /socket lost/);
    });
  });
});
