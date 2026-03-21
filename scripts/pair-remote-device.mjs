#!/usr/bin/env node
/**
 * Remote Pairing CLI. Requires `npm run build` so imports resolve under `build/`.
 */
import { Command } from 'commander';

import {
  RemotePairingService,
  UserInputService,
} from '../build/src/lib/remote-pairing/index.js';
import { getLogger } from '../build/src/lib/logger.js';

const log = getLogger('RemotePairingCLI');

export async function main() {
  const program = new Command();
  program
    .name('pair-remote-device')
    .description(
      'Pair iPhone, iPad, Apple TV, etc. over Wi‑Fi via _remotepairing._tcp',
    )
    .option(
      '-d, --device <selector>',
      'Device selector: name, identifier (UDID/MAC), or index (e.g. 0)',
    );

  program.parse(process.argv);
  const options = program.opts();

  const userInput = new UserInputService();
  const pairingService = new RemotePairingService(userInput);
  const result = await pairingService.discoverAndPair(options.device);

  if (result.success) {
    log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
  } else {
    const error = result.error ?? new Error('Pairing failed');
    log.error(`Pairing failed: ${error.message}`);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  log.error(error);
  process.exit(1);
}
