import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {getLogger} from '../../logger.js';

const execFileAsync = promisify(execFile);

const log = getLogger('RemotedController');

const REMOTED_PROCESS_NAME = 'remoted';
const PGREP_BIN = 'pgrep';
const PGREP_NO_MATCH_EXIT_CODE = 1;

/**
 * Suspends and resumes macOS' `remoted` daemon around tunnel operations.
 *
 * `remoted` holds the trusted RemoteXPC tunnel for any paired device on this
 * Mac. While it is active, the device may refuse a second `createListener`
 * request from another client (returning `errorExtended`). Suspending
 * `remoted` with SIGSTOP for the duration of the tunnel handshake, then
 * resuming it with SIGCONT, avoids that conflict. This class implements
 * that behavior and is a no-op on non-darwin platforms.
 */
export class RemotedController {
  private suspendedPid: number | null = null;

  /**
   * Suspends `remoted` if it is currently running and not already suspended
   * by this controller. No-op on non-darwin platforms. Safe to call multiple
   * times.
   */
  async suspend(): Promise<void> {
    if (process.platform !== 'darwin' || this.suspendedPid !== null) {
      return;
    }
    const pids = await findPidsByName(REMOTED_PROCESS_NAME);
    if (pids.length === 0) {
      log.debug('remoted is not running; nothing to suspend');
      return;
    }
    const pid = pids[0];
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
      log.warn(`Failed to suspend remoted (pid ${pid}); continuing without suspension: ${reason}`);
    }
  }

  /**
   * Resumes the `remoted` process previously suspended by this controller.
   * No-op when nothing has been suspended. Safe to call multiple times.
   */
  resume(): void {
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
 * Locate all running processes that exactly match `name` and return their PIDs.
 * Uses `pgrep -x` (exact match on process name) which is robust against
 * launchd adding arguments to the daemon's command line.
 *
 * Returns an empty list when no processes match (`pgrep` exit code 1) or
 * when `pgrep` itself cannot be invoked.
 */
async function findPidsByName(name: string): Promise<number[]> {
  try {
    const {stdout} = await execFileAsync(PGREP_BIN, ['-x', name]);
    return stdout
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch (err) {
    const code = (err as {code?: unknown})?.code;
    if (code !== PGREP_NO_MATCH_EXIT_CODE) {
      log.debug(`pgrep failed for "${name}": ${err}`);
    }
    return [];
  }
}
