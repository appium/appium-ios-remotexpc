#!/usr/bin/env node
/**
 * Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels.
 *
 * Usage:
 *   npm run pair-appletv -- [options]
 */

import { logger } from '@appium/support';
import { Command } from 'commander';
import { AppleTVPairingService, UserInputService } from 'appium-ios-remotexpc';

const log = logger.getLogger('AppleTVPairing');

async function main() {
  const program = new Command();
  program
    .name('pair-appletv')
    .description('Pair Apple TV / tvOS devices over WiFi for Remote XPC tunnels')
    .option(
      '-d, --device <selector>',
      'Device selector: name, identifier (e.g. AA:BB:CC:DD:EE:FF), or index (0, 1, …)',
    );

  program.parse(process.argv);
  const options = program.opts();

  const userInput = new UserInputService();
  const pairingService = new AppleTVPairingService(userInput);
  const result = await pairingService.discoverAndPair(options.device);

  if (result.success) {
    log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
  } else {
    throw result.error ?? new Error('Pairing failed');
  }
}

await main();
