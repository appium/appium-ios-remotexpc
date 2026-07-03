import {describe, it} from 'node:test';

import {expect} from 'chai';

import {PowerAssertionService, PowerAssertionType} from '../../../src/services/ios/power-assertion/index.js';

describe('PowerAssertionService', function () {
  describe('PowerAssertionService instantiation', function () {
    it('should create a service with valid udid', function () {
      const service = new PowerAssertionService('test-udid');
      expect(service).to.be.instanceOf(PowerAssertionService);
    });
  });

  describe('buildCreateAssertionRequest', function () {
    it('should build request without details', function () {
      const service = new PowerAssertionService('test-udid');
      const request = (service as any).buildCreateAssertionRequest({
        type: PowerAssertionType.PREVENT_USER_IDLE_SYSTEM_SLEEP,
        name: 'TestAssertion',
        timeout: 30,
      });

      expect(request).to.deep.equal({
        CommandKey: 'CommandCreateAssertion',
        AssertionTypeKey: 'PreventUserIdleSystemSleep',
        AssertionNameKey: 'TestAssertion',
        AssertionTimeoutKey: 30,
      });
    });

    it('should build request with details', function () {
      const service = new PowerAssertionService('test-udid');
      const request = (service as any).buildCreateAssertionRequest({
        type: PowerAssertionType.PREVENT_SYSTEM_SLEEP,
        name: 'TestAssertion',
        timeout: 60,
        details: 'Running important task',
      });

      expect(request).to.deep.equal({
        CommandKey: 'CommandCreateAssertion',
        AssertionTypeKey: 'PreventSystemSleep',
        AssertionNameKey: 'TestAssertion',
        AssertionTimeoutKey: 60,
        AssertionDetailKey: 'Running important task',
      });
    });
  });
});
