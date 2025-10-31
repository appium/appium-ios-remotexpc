import { logger } from '@appium/support';
import { expect } from 'chai';

import type { DVTServiceWithConnection } from '../../src/index.js';
import type { LocationCoordinates } from '../../src/services/ios/dvt/instruments/location-simulation.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('LocationSimulation.test');
log.level = 'debug';

describe('LocationSimulation Integration', function () {
  this.timeout(30000);

  let dvtServiceConnection: DVTServiceWithConnection | null = null;
  const udid = process.env.UDID || '00008030-001E290A3EF2402E';

  before(async () => {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }

    log.debug(`Connecting to DVT service for device: ${udid}`);
    dvtServiceConnection = await Services.startDVTService(udid);
    log.debug('DVT service connected successfully');
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        // Clear any location simulation before closing
        await dvtServiceConnection.locationSimulation.clear();
      } catch (error) {
        log.debug('Error clearing location simulation:', error);
      }

      try {
        await dvtServiceConnection.dvtService.close();
      } catch (error) {
        log.debug('Error closing DVT service:', error);
      }
      
      try {
        await dvtServiceConnection.remoteXPC.close();
      } catch (error) {
        log.debug('Error closing RemoteXPC:', error);
      }
    }
  });

  describe('DVT Service Connection', () => {
    it('should connect to DVT service and get supported identifiers', async () => {
      expect(dvtServiceConnection).to.not.be.null;
      expect(dvtServiceConnection!.dvtService).to.not.be.null;
      expect(dvtServiceConnection!.locationSimulation).to.not.be.null;

      const supportedIdentifiers = dvtServiceConnection!.dvtService.getSupportedIdentifiers();
      console.log("supportedIdentifiers are: ", supportedIdentifiers);
      expect(supportedIdentifiers).to.be.an('object');
      expect(Object.keys(supportedIdentifiers).length).to.be.greaterThan(0);
      
      log.debug(`Found ${Object.keys(supportedIdentifiers).length} supported identifiers`);
      
      // Check if location simulation is supported
      const hasLocationSimulation = Object.keys(supportedIdentifiers).some(
        key => key.includes('LocationSimulation')
      );
      expect(hasLocationSimulation).to.be.true;
    });
  });

  describe('Location Simulation', () => {
    it('should set location to Apple Park', async () => {
      const appleParkLocation: LocationCoordinates = {
        latitude: 37.334606,
        longitude: -122.009102,
      };

      await dvtServiceConnection!.locationSimulation.setLocation(
        appleParkLocation.latitude,
        appleParkLocation.longitude
      );

      log.info(`Location set to Apple Park: ${appleParkLocation.latitude}, ${appleParkLocation.longitude}`);
      
      // Wait a bit to ensure the location is set
      await new Promise(resolve => setTimeout(resolve, 1000));
    });

    it('should set location to multiple coordinates', async () => {
      const locations = [
        { name: 'Statue of Liberty', latitude: 40.689247, longitude: -74.044502 },
        { name: 'Eiffel Tower', latitude: 48.858370, longitude: 2.294481 },
        { name: 'Sydney Opera House', latitude: -33.856784, longitude: 151.215297 },
      ];

      for (const location of locations) {
        await dvtServiceConnection!.locationSimulation.setLocation(
          location.latitude,
          location.longitude
        );
        
        log.info(`Location set to ${location.name}: ${location.latitude}, ${location.longitude}`);
        
        // Wait between location changes
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    });

    it('should clear location simulation', async () => {
      // First set a location
      await dvtServiceConnection!.locationSimulation.setLocation(37.334606, -122.009102);
      log.info('Location set to Apple Park');
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Clear the location simulation
      await dvtServiceConnection!.locationSimulation.clear();
      log.info('Location simulation cleared');
    });

    it('should handle rapid location changes', async () => {
      // Test rapid location changes to ensure the service handles them properly
      const locations: LocationCoordinates[] = [
        { latitude: 37.7749, longitude: -122.4194 }, // San Francisco
        { latitude: 34.0522, longitude: -118.2437 }, // Los Angeles
        { latitude: 40.7128, longitude: -74.0060 },  // New York
        { latitude: 41.8781, longitude: -87.6298 },  // Chicago
        { latitude: 47.6062, longitude: -122.3321 }, // Seattle
      ];

      for (const location of locations) {
        await dvtServiceConnection!.locationSimulation.setLocation(
          location.latitude,
          location.longitude
        );
        // Minimal delay between changes
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      log.info('Rapid location changes completed successfully');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid coordinates gracefully', async () => {
      try {
        // Test with invalid latitude (> 90)
        await dvtServiceConnection!.locationSimulation.setLocation(91.0, 0.0);
        // If it doesn't throw, that's also acceptable behavior
        log.debug('Invalid latitude accepted by service');
      } catch (error) {
        log.debug('Expected error for invalid latitude:', error);
        expect(error).to.exist;
      }

      try {
        // Test with invalid longitude (> 180)
        await dvtServiceConnection!.locationSimulation.setLocation(0.0, 181.0);
        // If it doesn't throw, that's also acceptable behavior
        log.debug('Invalid longitude accepted by service');
      } catch (error) {
        log.debug('Expected error for invalid longitude:', error);
        expect(error).to.exist;
      }
    });
  });
});
