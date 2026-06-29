import { logger } from '@appium/support';
import { after, before, describe, it } from 'node:test';

import type {
  PowerAssertionOptions,
  PowerAssertionService,
} from '../../src/index.js';
import { PowerAssertionType } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { requireDeviceUdid } from './helpers/device.js';

const log = logger.getLogger('PowerAssertionService.test');
log.level = 'debug';

describe('PowerAssertionService Integration', { timeout: 30000 }, function () {
  let powerAssertionService: PowerAssertionService;
  const udid = requireDeviceUdid();

  before(async () => {
    powerAssertionService = await Services.startPowerAssertionService(udid);
  });

  after(async () => {
    try {
      await powerAssertionService?.close();
    } catch {}
  });

  it('should create power assertion and verify in syslog', async function () {
    const assertionName = 'KeepAwakeTest';

    const options: PowerAssertionOptions = {
      type: PowerAssertionType.PREVENT_SYSTEM_SLEEP,
      name: assertionName,
      timeout: 1,
    };

    // Create power assertion of 2 seconds
    await powerAssertionService.createPowerAssertion(options);
  });

  it('should create power assertion with details', async function () {
    const assertionName = 'DetailedAssertionTest';
    const assertionDetails = 'Power Assertion with Details';

    // Create power assertion with details of 3 seconds
    await powerAssertionService.createPowerAssertion({
      type: PowerAssertionType.WIRELESS_SYNC,
      name: assertionName,
      timeout: 3,
      details: assertionDetails,
    });
  });
});
