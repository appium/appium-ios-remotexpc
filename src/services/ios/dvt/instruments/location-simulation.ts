import { logger } from '@appium/support';

import type { Channel } from '../channel.js';
import type { DVTSecureSocketProxyService } from '../index.js';
import { MessageAux } from '../dtx-message.js';

const log = logger.getLogger('LocationSimulation');

/**
 * Location coordinates interface
 */
export interface LocationCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Location simulation service for simulating device location
 * Based on pymobiledevice3's LocationSimulation
 */
export class LocationSimulation {
  static readonly IDENTIFIER = 'com.apple.instruments.server.services.LocationSimulation';
  
  private readonly dvt: DVTSecureSocketProxyService;
  private channel: Channel | null = null;

  constructor(dvt: DVTSecureSocketProxyService) {
    this.dvt = dvt;
  }

  /**
   * Initialize the location simulation channel
   */
  async initialize(): Promise<void> {
    if (this.channel) {
      log.debug('Location simulation channel already initialized');
      return;
    }

    log.debug('Initializing location simulation channel');
    this.channel = await this.dvt.makeChannel(LocationSimulation.IDENTIFIER);
  }

  /**
   * Set the simulated location
   * @param coordinates The location coordinates
   */
  async set(coordinates: LocationCoordinates): Promise<void> {
    await this.initialize();

    const args = new MessageAux()
      .appendObj(coordinates.latitude)
      .appendObj(coordinates.longitude);

    // Send location simulation command
    await this.channel!.call('simulateLocationWithLatitude_longitude_')(args);
    
    // Wait for response
    await this.channel!.receivePlist();

    log.info(`Location set to: ${coordinates.latitude}, ${coordinates.longitude}`);
  }

  /**
   * Set the simulated location using separate latitude and longitude parameters
   * @param latitude The latitude
   * @param longitude The longitude
   */
  async setLocation(latitude: number, longitude: number): Promise<void> {
    await this.set({ latitude, longitude });
  }

  /**
   * Clear/stop location simulation
   */
  async clear(): Promise<void> {
    await this.initialize();

    // Send stop location simulation command
    await this.channel!.call('stopLocationSimulation')();

    log.info('Location simulation stopped');
  }

  /**
   * Stop location simulation (alias for clear)
   */
  async stop(): Promise<void> {
    await this.clear();
  }
}
