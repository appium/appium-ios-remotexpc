/**
 * Cross-platform elevation wrapper.
 * On Windows: runs the script directly (caller must be in an elevated terminal).
 * On macOS/Linux: prefixes with sudo.
 *
 * Usage: node scripts/run-elevated.mjs <script> [args...]
 */
import {spawnSync} from 'node:child_process';

const [, , script, ...args] = process.argv;

if (!script) {
  console.error('Usage: node scripts/run-elevated.mjs <script> [args...]');
  process.exit(1);
}

const cmd =
  process.platform === 'win32'
    ? {bin: process.execPath, argv: [script, ...args]}
    : {bin: 'sudo', argv: [process.execPath, script, ...args]};

const result = spawnSync(cmd.bin, cmd.argv, {stdio: 'inherit'});
process.exit(result.status ?? 1);
