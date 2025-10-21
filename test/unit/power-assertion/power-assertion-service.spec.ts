import { expect } from 'chai';

import {
  PowerAssertionService,
  PowerAssertionType,
} from '../../../src/services/ios/power-assertion/index.js';

describe('PowerAssertionService', function () {
  describe('PowerAssertionService instantiation', function () {
    it('should create a service with valid address', function () {
      const service = new PowerAssertionService(['127.0.0.1', 12345]);
      expect(service).to.be.instanceOf(PowerAssertionService);
    });
  });

  describe('buildCreateAssertionRequest', function () {
    it('should build request without details', function () {
      const service = new PowerAssertionService(['127.0.0.1', 12345]);
      const request = (service as any).buildCreateAssertionRequest(
        PowerAssertionType.PREVENT_USER_IDLE_SYSTEM_SLEEP,
        'TestAssertion',
        30,
      );

      expect(request).to.deep.equal({
        CommandKey: 'CommandCreateAssertion',
        AssertionTypeKey: 'PreventUserIdleSystemSleep',
        AssertionNameKey: 'TestAssertion',
        AssertionTimeoutKey: 30,
      });
    });

    it('should build request with details', function () {
      const service = new PowerAssertionService(['127.0.0.1', 12345]);
      const request = (service as any).buildCreateAssertionRequest(
        PowerAssertionType.PREVENT_SYSTEM_SLEEP,
        'TestAssertion',
        60,
        'Running important task',
      );

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
