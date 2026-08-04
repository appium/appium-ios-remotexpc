import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';

import type {ConditionGroup, DVTInstruments} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('ConditionInducer.test');
log.level = 'debug';

describe('Condition Inducer Instrument', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async () => {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.conditionInducer.disable();
      } catch {}

      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
    }
  });

  describe('List Available Conditions', () => {
    it('should list all available condition inducers', async () => {
      const groups: ConditionGroup[] = await dvtServiceConnection!.conditionInducer.list();

      assert.ok(Array.isArray(groups));
      assert.ok(groups.length > 0);

      // Verify structure
      for (const group of groups) {
        assert.ok('identifier' in group);
        assert.ok(typeof group.identifier === 'string');

        if (group.profiles) {
          assert.ok(Array.isArray(group.profiles));
          for (const profile of group.profiles) {
            assert.ok('identifier' in profile);
            assert.ok(typeof profile.identifier === 'string');
          }
        }
      }
    });

    it('should find network condition profiles', async () => {
      const groups: ConditionGroup[] = await dvtServiceConnection!.conditionInducer.list();

      // Look for network-related conditions
      const hasNetworkConditions = groups.some(
        (group) =>
          group.identifier.toLowerCase().includes('network') ||
          (group.profiles && group.profiles.some((p) => p.identifier.toLowerCase().includes('network'))),
      );
      assert.strictEqual(hasNetworkConditions, true);
    });
  });

  describe('Set Condition Profile', () => {
    // to verify, increase the timeout and try accessing the internet on the device, you will notice network issues
    it('should set a condition profile if available and verify disable', async function () {
      const networkProfile = 'SlowNetwork100PctLoss'; // 100% packet loss

      // Set the condition
      await dvtServiceConnection!.conditionInducer.set(networkProfile);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // verify whether isActive is true for the network profile identifier - SlowNetworkCondition
      const groups: ConditionGroup[] = await dvtServiceConnection!.conditionInducer.list();

      const networkGroup = groups.find((g) => g.identifier === 'SlowNetworkCondition');
      const networkProfileIdentifierStatus = networkGroup ? networkGroup.isActive : false;

      assert.strictEqual(networkProfileIdentifierStatus, true);

      await dvtServiceConnection!.conditionInducer.disable();

      // check that disable works
      const groupsAfterDisable: ConditionGroup[] = await dvtServiceConnection!.conditionInducer.list();
      const networkGroupAfterDisable = groupsAfterDisable.find((g) => g.identifier === 'SlowNetworkCondition');
      const networkProfileIdentifierStatusAfterDisable = networkGroupAfterDisable
        ? networkGroupAfterDisable.isActive
        : false;
      assert.strictEqual(networkProfileIdentifierStatusAfterDisable, false);
    });

    it('should handle invalid profile identifier gracefully', async () => {
      try {
        await dvtServiceConnection!.conditionInducer.set('invalid.profile.identifier.12345');
        assert.fail('Should have thrown an error for invalid profile');
      } catch (error: any) {
        assert.ok(error !== null && error !== undefined);
        assert.ok(error.message.includes('Invalid profile identifier'));
      }
    });
  });
});
