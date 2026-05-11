import { spawn } from 'node:child_process';

import { getLogger } from '../../logger.js';

const log = getLogger('RemotedController');

const REMOTED_PROCESS_NAME = 'remoted';

/**
 * Suspends and resumes macOS' `remoted` daemon around tunnel operations.
 *
 * `remoted` holds the trusted RemoteXPC tunnel for any paired device on this
 * Mac. While it is active, the device may refuse a second `createListener`
 * request from another client (returning `errorExtended`). pymobiledevice3
 * solves this by SIGSTOP'ing `remoted` for the duration of the tunnel
 * handshake, then SIGCONT'ing it afterwards. This class mirrors that
 * behavior and is a no-op on non-darwin platforms.
 */
export class RemotedController {
  private suspendedPid: number | null = null;

  /**
   * Suspends `remoted` if it is running and not already suspended.
   * Safe to call multiple times.
   */
  async suspendIfRequired(): Promise<void> {
    if (process.platform !== 'darwin' || this.suspendedPid !== null) {
      return;
    }
    const pid = await findRemotedPid();
    if (pid === null) {
      log.debug('remoted is not running; nothing to suspend');
      return;
    }
    try {
      process.kill(pid, 'SIGSTOP');
      this.suspendedPid = pid;
      log.debug(`Suspended remoted (pid ${pid})`);
    } catch (err) {
      const reason =
        (err as NodeJS.ErrnoException)?.code === 'EPERM'
          ? `permission denied (run with sudo so we can SIGSTOP remoted; otherwise ` +
            `the device may reject createListener with "Tunnel listener creator not set")`
          : String(err);
      log.warn(
        `Failed to suspend remoted (pid ${pid}); continuing without suspension: ${reason}`,
      );
    }
  }

  /**
   * Resumes the `remoted` process previously suspended by this controller.
   * Safe to call multiple times.
   */
  resumeIfRequired(): void {
    if (this.suspendedPid === null) {
      return;
    }
    const pid = this.suspendedPid;
    this.suspendedPid = null;
    try {
      process.kill(pid, 'SIGCONT');
      log.debug(`Resumed remoted (pid ${pid})`);
    } catch (err) {
      log.warn(`Failed to resume remoted (pid ${pid}): ${err}`);
    }
  }
}

/**
 * Locate the running `remoted` process by exact process name.
 * Uses `pgrep -x` (exact match on process name) which is robust against
 * launchd adding arguments to the daemon's command line.
 */
function findRemotedPid(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('pgrep', ['-x', REMOTED_PROCESS_NAME]);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('exit', () => {
      const first = stdout.trim().split(/\s+/)[0];
      const pid = parseInt(first, 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}
