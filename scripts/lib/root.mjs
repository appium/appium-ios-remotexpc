import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Ensures a helper script is run with elevated privileges.
 *
 * @param {string} scriptName
 */
export async function assertRoot(scriptName) {
  if (process.platform === 'win32') {
    await assertWindowsAdmin(scriptName);
    return;
  }

  if (typeof process.getuid !== 'function') {
    return;
  }
  if (process.getuid() !== 0) {
    throw new Error(
      `This script must be run as root/admin (e.g. sudo node scripts/${scriptName}.mjs ...).`,
    );
  }
}

/**
 * @param {string} scriptName
 */
async function assertWindowsAdmin(scriptName) {
  try {
    await execFileAsync('net', ['session']);
  } catch {
    throw new Error(
      `This script must be run as Administrator (e.g. from an elevated terminal: node scripts/${scriptName}.mjs ...).`,
    );
  }
}
