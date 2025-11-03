import { logger } from '@appium/support';
import { expect } from 'chai';

import type {
  ConditionGroup,
  DVTServiceWithConnection,
} from '../../../src/index.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('ConditionInducer.test');
log.level = 'debug';

describe('Condition Inducer Instrument', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.conditionInducer.disable();
      } catch (error) {}

      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  describe('List Available Conditions', () => {
    it('should list all available condition inducers', async () => {
      const groups: ConditionGroup[] =
        await dvtServiceConnection!.conditionInducer.list();

      expect(groups).to.be.an('array');
      expect(groups.length).to.be.greaterThan(0);

      // Verify structure
      for (const group of groups) {
        expect(group).to.have.property('identifier');
        expect(group.identifier).to.be.a('string');

        if (group.profiles) {
          expect(group.profiles).to.be.an('array');
          for (const profile of group.profiles) {
            expect(profile).to.have.property('identifier');
            expect(profile.identifier).to.be.a('string');
          }
        }
      }
    });

    it('should find network condition profiles', async () => {
      const groups: ConditionGroup[] =
        await dvtServiceConnection!.conditionInducer.list();

      // Look for network-related conditions
      const hasNetworkConditions = groups.some(
        (group) =>
          group.identifier.toLowerCase().includes('network') ||
          (group.profiles &&
            group.profiles.some((p) =>
              p.identifier.toLowerCase().includes('network'),
            )),
      );
      expect(hasNetworkConditions).to.be.true;
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
      const groups: ConditionGroup[] =
        await dvtServiceConnection!.conditionInducer.list();

      const networkGroup = groups.find(
        (g) => g.identifier === 'SlowNetworkCondition',
      );
      const networkProfileIdentifierStatus = networkGroup
        ? networkGroup.isActive
        : false;

      expect(networkProfileIdentifierStatus).to.be.true;

      await dvtServiceConnection!.conditionInducer.disable();

      // check that disable works
      const groupsAfterDisable: ConditionGroup[] =
        await dvtServiceConnection!.conditionInducer.list();
      const networkGroupAfterDisable = groupsAfterDisable.find(
        (g) => g.identifier === 'SlowNetworkCondition',
      );
      const networkProfileIdentifierStatusAfterDisable =
        networkGroupAfterDisable ? networkGroupAfterDisable.isActive : false;
      expect(networkProfileIdentifierStatusAfterDisable).to.be.false;
    });

    it('should handle invalid profile identifier gracefully', async () => {
      try {
        await dvtServiceConnection!.conditionInducer.set(
          'invalid.profile.identifier.12345',
        );
        expect.fail('Should have thrown an error for invalid profile');
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.message).to.include('Invalid profile identifier');
      }
    });
  });
});
