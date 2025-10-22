import { logger } from '@appium/support';

import type { PowerAssertionService } from '../../src/index.js';
import * as Services from '../../src/services.js';
import { PowerAssertionType } from '../../src/services/ios/power-assertion/index.js';

const log = logger.getLogger('PowerAssertionService.test');
log.level = 'debug';

describe('PowerAssertionService Integration', function () {
  this.timeout(30000);

  let remoteXPC: any;
  let powerAssertionService: PowerAssertionService;
  const udid = process.env.UDID || '';

  before(async () => {
    if (!udid) throw new Error('set UDID env var to execute tests.');

    const result = await Services.startPowerAssertionService(udid);
    powerAssertionService = result.powerAssertionService;
    remoteXPC = result.remoteXPC;
  });

  after(async () => {
    if (powerAssertionService) {
      try {
        await powerAssertionService.close();
      } catch {} // ignore errors
    }
    if (remoteXPC) {
      try {
        await remoteXPC.close();
      } catch {} // ignore errors
    }
  });

  it('should create power assertion and verify in syslog', async function () {
    const assertionName = 'KeepAwakeTest';

    // Create power assertion of 2 seconds
    await powerAssertionService.createPowerAssertion({
      type: PowerAssertionType.PREVENT_SYSTEM_SLEEP,
      name: assertionName,
      timeout: 2,
    });
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
