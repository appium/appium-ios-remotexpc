import {after, before, describe, it} from 'node:test';

import {logger} from '@appium/support';
import {expect} from 'chai';

import type {DVTInstruments} from '../../../src/index.js';
import * as Services from '../../../src/services.js';
import type {LocationCoordinates} from '../../../src/services/ios/dvt/instruments/location-simulation.js';
import {requireDeviceUdid} from '../helpers/device.js';

const log = logger.getLogger('LocationSimulation.test');
log.level = 'debug';

describe('Location Simulation Instrument', {timeout: 30000}, function () {
  let dvtServiceConnection: DVTInstruments | null = null;
  let udid: string;

  before(async () => {
    udid = requireDeviceUdid();

    dvtServiceConnection = await Services.startDVTService(udid);
  });

  after(async () => {
    if (dvtServiceConnection) {
      try {
        await dvtServiceConnection.locationSimulation.clear();
      } catch {}

      try {
        await dvtServiceConnection.dvtService.close();
      } catch {}
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

      await dvtServiceConnection!.locationSimulation.set(appleParkLocation);

      // Wait to ensure location is set
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    it('should clear location simulation', async () => {
      await dvtServiceConnection!.locationSimulation.set({
        latitude: 37.334606,
        longitude: -122.009102,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await dvtServiceConnection!.locationSimulation.clear();
    });

    it('should handle rapid location changes', async () => {
      const locations: LocationCoordinates[] = [
        {latitude: 37.7749, longitude: -122.4194}, // San Francisco
        {latitude: 34.0522, longitude: -118.2437}, // Los Angeles
        {latitude: 40.7128, longitude: -74.006}, // New York
        {latitude: 41.8781, longitude: -87.6298}, // Chicago
        {latitude: 47.6062, longitude: -122.3321}, // Seattle
      ];

      for (const location of locations) {
        await dvtServiceConnection!.locationSimulation.setLocation(location.latitude, location.longitude);
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
