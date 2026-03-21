#!/usr/bin/env node
/**
 * Remote Pairing CLI. Requires `npm run build` so imports resolve under `build/`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import {
  RemotePairingService,
  UserInputService,
} from '../build/src/lib/remote-pairing/index.js';
import { getLogger } from '../build/src/lib/logger.js';

const log = getLogger('RemotePairingCLI');

/**
 * @param {string} [scriptName]
 */
export async function main(scriptName = 'pair-remote-device') {
  const program = new Command();
  program
    .name(scriptName)
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

const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  try {
    await main();
  } catch {
    process.exit(1);
  }
}
