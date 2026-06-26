import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import { AfcFileMode } from '../../src/services/ios/afc/enums.js';
import type AfcService from '../../src/services/ios/afc/index.js';
import { requireDeviceUdid } from './helpers/device.js';

const log = getLogger('AFC.PushPerformance.test');

const MIB = 1024 * 1024;
const DEFAULT_PUSH_SIZE_BYTES = 10 * MIB;
const DEFAULT_MAX_DURATION_MS = 120_000;

/**
 * Integration test for large AFC uploads over an active RemoteXPC tunnel.
 *
 * Required:
 * - UDID: target device UDID
 * - Tunnel registry running (e.g. `sudo npm run test:tunnel-creation`)
 *
 * Optional:
 * - AFC_PUSH_SIZE_BYTES: upload size in bytes (default: 10 MiB)
 * - AFC_PUSH_MAX_MS: max allowed upload duration in ms (default: 120000)
 *
 * Example:
 *   UDID=... AFC_PUSH_MAX_MS=60000 npm run test:afc-push-perf
 */
describe('AFC push performance', function () {
  const udid = requireDeviceUdid();
  const pushSizeBytes = parsePositiveInt(
    process.env.AFC_PUSH_SIZE_BYTES,
    DEFAULT_PUSH_SIZE_BYTES,
  );
  const maxDurationMs = parsePositiveInt(
    process.env.AFC_PUSH_MAX_MS,
    DEFAULT_MAX_DURATION_MS,
  );

  // Mocha hook timeout must exceed the perf ceiling plus setup/teardown.
  this.timeout(maxDurationMs + 30_000);

  let afc: AfcService;
  let localPath = '';
  let remotePath = '';

  before(async function () {
    localPath = path.join(
      os.tmpdir(),
      `afc_push_perf_${Date.now()}_${pushSizeBytes}.bin`,
    );
    remotePath = `/Downloads/afc_push_perf_${Date.now()}.bin`;

    log.info(
      `Preparing ${formatMiB(pushSizeBytes)} local file at ${localPath}`,
    );
    await writeFixedSizeFile(localPath, pushSizeBytes);

    afc = await Services.startAfcService(udid);
  });

  after(async function () {
    try {
      if (afc && remotePath) {
        await afc.rm(remotePath, true);
      }
    } catch {
      // ignore cleanup errors
    }
    try {
      afc?.close();
    } catch {
      // ignore
    }
    if (localPath) {
      try {
        await fs.unlink(localPath);
      } catch {
        // ignore
      }
    }
  });

  it('should push a large file within the configured duration budget', async function () {
    log.info(
      `Uploading ${formatMiB(pushSizeBytes)} to ${remotePath} (max ${maxDurationMs}ms)`,
    );

    const startedAt = performance.now();
    await afc.push(localPath, remotePath);
    const elapsedMs = performance.now() - startedAt;

    const stat = await afc.stat(remotePath);
    expect(stat.st_ifmt).to.equal(AfcFileMode.S_IFREG);
    expect(stat.st_size).to.equal(BigInt(pushSizeBytes));

    const mibPerSecond = pushSizeBytes / MIB / (elapsedMs / 1000);
    log.info(
      `AFC push completed in ${elapsedMs.toFixed(0)}ms (${mibPerSecond.toFixed(2)} MiB/s)`,
    );

    expect(elapsedMs).to.be.lessThan(
      maxDurationMs,
      `expected push to finish within ${maxDurationMs}ms but took ${elapsedMs.toFixed(0)}ms (${mibPerSecond.toFixed(2)} MiB/s)`,
    );
  });
});

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

function formatMiB(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

async function writeFixedSizeFile(
  filePath: string,
  sizeBytes: number,
): Promise<void> {
  const chunk = Buffer.alloc(MIB, 0x42);
  const handle = await fs.open(filePath, 'w');
  try {
    let written = 0;
    while (written < sizeBytes) {
      const toWrite = Math.min(chunk.length, sizeBytes - written);
      await handle.write(chunk.subarray(0, toWrite));
      written += toWrite;
    }
  } finally {
    await handle.close();
  }
}
