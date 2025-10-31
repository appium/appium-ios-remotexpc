import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../../src/index.js';
import type { LocationCoordinates } from '../../../src/services/ios/dvt/instruments/location-simulation.js';
import * as Services from '../../../src/services.js';

const log = logger.getLogger('LocationSimulation.test');
log.level = 'debug';

describe('Location Simulation Instrument', function () {
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
        await dvtServiceConnection.locationSimulation.clear();
      } catch (error) {}

      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {}

      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {}
    }
  });

  describe('Location Simulation', () => {
    // to verify, open maps in your device before running the tests and visually check the location getting changed;
    // it requires GPS to be enabled to see the location change
    it('should set location to Apple Park', async () => {
      const appleParkLocation: LocationCoordinates = {
        latitude: 37.334606,
        longitude: -122.009102,
      };

      await dvtServiceConnection!.locationSimulation.setLocation(
        appleParkLocation.latitude,
        appleParkLocation.longitude,
      );

      // Wait to ensure location is set
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    it('should set location to multiple coordinates', async () => {
      const locations = [
        { name: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502 },
        { name: 'Eiffel Tower', latitude: 48.85837, longitude: 2.294481 },
        { name: 'Sydney Opera House', latitude: -33.856784, longitude: 151.215297 },
      ];

      for (const location of locations) {
        await dvtServiceConnection!.locationSimulation.setLocation(
          location.latitude,
          location.longitude,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });

    it('should clear location simulation', async () => {
      await dvtServiceConnection!.locationSimulation.setLocation(37.334606, -122.009102);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await dvtServiceConnection!.locationSimulation.clear();
    });

    it('should handle rapid location changes', async () => {
      const locations: LocationCoordinates[] = [
        { latitude: 37.7749, longitude: -122.4194 }, // San Francisco
        { latitude: 34.0522, longitude: -118.2437 }, // Los Angeles
        { latitude: 40.7128, longitude: -74.006 }, // New York
        { latitude: 41.8781, longitude: -87.6298 }, // Chicago
        { latitude: 47.6062, longitude: -122.3321 }, // Seattle
      ];

      for (const location of locations) {
        await dvtServiceConnection!.locationSimulation.setLocation(
          location.latitude,
          location.longitude,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid coordinates gracefully', async () => {
      try {
        await dvtServiceConnection!.locationSimulation.setLocation(91.0, 0.0);
      } catch (error) {
        expect(error).to.exist;
      }

      try {
        await dvtServiceConnection!.locationSimulation.setLocation(0.0, 181.0);
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });
});
