#!/usr/bin/env tsx
import { logger } from '@appium/support';

import {
  AppleTVPairingService,
  UserInputService,
} from '../src/lib/apple-tv/index.js';

interface CLIArgs {
  device?: string;
  help?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {};
  const cliArgs = process.argv.slice(2);

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];
    if (arg === '--device' || arg === '-d') {
      args.device = cliArgs[++i];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
Apple TV Pairing Script

Usage: pair-appletv [options]

Options:
  -d, --device <selector>   Specify device to pair with. Can be:
                            - Device name (e.g., "Living Room")
                            - Device identifier (e.g., "AA:BB:CC:DD:EE:FF")
                            - Device index (e.g., "0", "1", "2")
                            If not specified and multiple devices are found,
                            you will be prompted to choose one.
  -h, --help               Show this help message

Examples:
  pair-appletv                           # Discover and select device interactively
  pair-appletv --device "Living Room"    # Pair with device named "Living Room"
  pair-appletv --device 0                # Pair with first discovered device
  pair-appletv -d AA:BB:CC:DD:EE:FF      # Pair with device by identifier
`);
}

// CLI interface
async function main(): Promise<void> {
  const log = logger.getLogger('AppleTVPairing');
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  const userInput = new UserInputService();
  const pairingService = new AppleTVPairingService(userInput);
  const result = await pairingService.discoverAndPair(args.device);

  if (result.success) {
    log.info(`Pairing successful! Record saved to: ${result.pairingFile}`);
  } else {
    const error = result.error ?? new Error('Pairing failed');
    log.error(`Pairing failed: ${error.message}`);
    throw error;
  }
}

main().catch(() => {
  process.exit(1);
});
