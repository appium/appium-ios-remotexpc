import { logger } from '@appium/support';

import type { Channel } from '../channel.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';

const log = logger.getLogger('LocationSimulation');

/**
 * Geographic coordinates
 */
export interface LocationCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Location simulation service for simulating device GPS location
 */
export class LocationSimulation {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.LocationSimulation';

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
      return;
    }

    this.channel = await this.dvt.makeChannel(LocationSimulation.IDENTIFIER);
  }

  /**
   * Set the simulated GPS location
   * @param coordinates The location coordinates
   */
  async set(coordinates: LocationCoordinates): Promise<void> {
    await this.initialize();

    const args = new MessageAux()
      .appendObj(coordinates.latitude)
      .appendObj(coordinates.longitude);

    await this.channel!.call('simulateLocationWithLatitude_longitude_')(args);
    await this.channel!.receivePlist();

    log.info(
      `Location set to: ${coordinates.latitude}, ${coordinates.longitude}`,
    );
  }

  /**
   * Set the simulated GPS location
   * @param latitude The latitude coordinate
   * @param longitude The longitude coordinate
   */
  async setLocation(latitude: number, longitude: number): Promise<void> {
    await this.set({ latitude, longitude });
  }

  /**
   * Stop location simulation and restore actual device location
   */
  async clear(): Promise<void> {
    await this.initialize();
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
