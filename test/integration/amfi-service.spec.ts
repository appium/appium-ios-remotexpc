import assert from 'node:assert/strict';
import {before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {AmfiService} from '../../src/lib/types.js';
import * as Services from '../../src/services.js';
import {AmfiError} from '../../src/services/ios/amfi/errors.js';
import {requireDeviceUdid} from './helpers/device.js';

const log = logger.getLogger('AmfiService.test');
log.level = 'info';

// Actions 1 and 2 change device state and involve a reboot, so each is opt-in.
// Run the enable step alone, wait for the device to come back, unlock it (leave the
// "Turn on Developer Mode?" alert on screen), recreate the tunnel, then run the accept step.
const RUN_ENABLE = process.env.AMFI_RUN_ENABLE === '1';
const RUN_ACCEPT = process.env.AMFI_RUN_ACCEPT === '1';

describe('AmfiService', {timeout: 60000}, function () {
  let amfiService: AmfiService;
  let udid: string;

  before(async function () {
    udid = requireDeviceUdid();
    amfiService = await Services.startAmfiService(udid);
  });

  it('reads the Developer Mode status and agrees with the image mounter', async function () {
    const enabled = await amfiService.isDeveloperModeEnabled();
    log.info(`Developer Mode enabled: ${enabled}`);

    const mounter = await Services.startMobileImageMounterService(udid);
    try {
      assert.strictEqual(await mounter.queryDeveloperModeStatus(), enabled);
    } finally {
      await mounter.cleanup();
    }
  });

  it('reveals the Developer Mode toggle without changing state', async function () {
    await amfiService.revealDeveloperModeOption();
  });

  it('reveals idempotently on a second call', async function () {
    await amfiService.revealDeveloperModeOption();
  });

  it(
    'enables Developer Mode, or is a no-op when already on',
    {
      skip:
        !RUN_ENABLE &&
        'set AMFI_RUN_ENABLE=1 to run; the device reboots when Developer Mode is off, and a passcode fails the test',
    },
    async function () {
      if (await amfiService.isDeveloperModeEnabled()) {
        await amfiService.enableDeveloperMode();
        assert.strictEqual(await amfiService.isDeveloperModeEnabled(), true, 'enable must not re-arm Developer Mode');
        log.info('Developer Mode already on; enable was a no-op');
        return;
      }

      // A passcode makes AMFI reject the action; the DeviceHasPasscodeSetError propagates and fails the test.
      await amfiService.enableDeveloperMode();
      log.info('Enable accepted; the device is rebooting');
    },
  );

  it(
    'accepts the post-reboot Developer Mode prompt',
    {skip: !RUN_ACCEPT && 'set AMFI_RUN_ACCEPT=1 to run after the device has rebooted'},
    async function () {
      try {
        await amfiService.acceptDeveloperModePrompt();
      } catch (error) {
        // Observed on iOS 26: AMFI answers with this generic string whenever no prompt is pending,
        // both when Developer Mode is already on and when enable was never sent.
        if (error instanceof AmfiError && error.code === 'An unknown error has occured') {
          throw new Error(
            'No Developer Mode prompt is pending on the device. Run the enable step first, ' +
              'let the device reboot, unlock it and leave the "Turn on Developer Mode?" alert on screen.',
            {cause: error},
          );
        }
        throw error;
      }

      assert.strictEqual(await amfiService.isDeveloperModeEnabled(), true, 'Developer Mode should be on after accept');
    },
  );
});
