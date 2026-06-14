import { expect } from 'chai';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { getLogger } from '../../src/lib/logger.js';
import * as Services from '../../src/services.js';
import { AfcFileMode } from '../../src/services/ios/afc/enums.js';
import type AfcService from '../../src/services/ios/afc/index.js';

const log = getLogger('AFC.TunnelStability.test');

const MIB = 1024 * 1024;

/**
 * Integration tunnel stability check: upload and download the same AFC file many times
 * on one session (exercises bidirectional tunnel traffic + TCP ACK path).
 *
 * Required:
 * - UDID
 * - Tunnel registry running (`sudo npm run tunnel-creation`)
 *
 * Optional:
 * - AFC_STABILITY_ITERATIONS — round trips (default: 5)
 * - AFC_STABILITY_FILE_SIZE_BYTES — payload size (default: 10 MiB)
 * - AFC_STABILITY_MAX_MS — per-round budget for push+pull (default: 120000)
 * - AFC_STABILITY_HEARTBEAT_MS — pipeline progress log interval (default: 5000)
 * - AFC_STABILITY_WRITE_CHUNK_BYTES — AFC WRITE chunk size (default: 128 KiB)
 *
 * Example:
 *   UDID=... npm run test:afc-tunnel-stability
 */
describe('AFC tunnel stability', function () {
  const udid = process.env.UDID || '';
  const iterations = parsePositiveInt(process.env.AFC_STABILITY_ITERATIONS, 5);
  const fileSizeBytes = parsePositiveInt(
    process.env.AFC_STABILITY_FILE_SIZE_BYTES,
    10 * MIB,
  );
  const maxRoundMs = parsePositiveInt(
    process.env.AFC_STABILITY_MAX_MS,
    120_000,
  );
  const writeChunkBytes = parsePositiveInt(
    process.env.AFC_STABILITY_WRITE_CHUNK_BYTES,
    128 * 1024,
  );

  this.timeout(iterations * (maxRoundMs + 30_000) + 120_000);

  let afc: AfcService;
  let localSourcePath = '';
  let localPullDir = '';
  let remotePath = '';
  let sourceSha256 = '';

  before(async function () {
    if (!udid) {
      log.warn('Skipping: set UDID');
      this.skip();
      return;
    }

    const tag = Date.now();
    localSourcePath = path.join(
      os.tmpdir(),
      `afc_stability_src_${tag}_${fileSizeBytes}.bin`,
    );
    localPullDir = path.join(os.tmpdir(), `afc_stability_pull_${tag}`);
    remotePath = `/Downloads/afc_stability_${tag}.bin`;

    log.info(
      `Preparing ${formatMiB(fileSizeBytes)} source at ${localSourcePath}`,
    );
    await writeFixedSizeFile(localSourcePath, fileSizeBytes);
    sourceSha256 = await sha256File(localSourcePath);
    await fsp.mkdir(localPullDir, { recursive: true });

    afc = await Services.startAfcService(udid);
    attachAfcSocketDiagnostics(afc, log);
  });

  after(async function () {
    try {
      if (afc && remotePath) {
        await afc.rm(remotePath, true);
      }
    } catch {
      // ignore
    }
    try {
      afc?.close();
    } catch {
      // ignore
    }
    for (const p of [localSourcePath, localPullDir]) {
      if (!p) {
        continue;
      }
      try {
        await fsp.rm(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('should upload and download the same file repeatedly on one AFC session', async function () {
    log.info(
      `Running ${iterations} push+pull rounds (${formatMiB(fileSizeBytes)} each, ` +
        `writeChunk=${formatMiB(writeChunkBytes)}, max ${maxRoundMs}ms/round)`,
    );

    const roundStats: Array<{
      round: number;
      pushMs: number;
      pullMs: number;
      totalMs: number;
      mibPerSecond: number;
    }> = [];

    for (let round = 1; round <= iterations; round++) {
      const pullPath = path.join(localPullDir, `round_${round}.bin`);
      const roundStart = performance.now();

      log.info(`round ${round}/${iterations} begin`);

      const pushStart = performance.now();
      await pushWithSteps(
        afc,
        round,
        localSourcePath,
        remotePath,
        writeChunkBytes,
      );
      const pushMs = performance.now() - pushStart;

      const stat = await logStep(round, 'verify.stat', () =>
        afc.stat(remotePath),
      );
      expect(stat.st_ifmt).to.equal(AfcFileMode.S_IFREG);
      expect(stat.st_size).to.equal(BigInt(fileSizeBytes));

      const pullStart = performance.now();
      await pullWithSteps(afc, round, remotePath, pullPath);
      const pullMs = performance.now() - pullStart;

      const totalMs = performance.now() - roundStart;
      const pulledSha256 = await logStep(round, 'verify.sha256', () =>
        sha256File(pullPath),
      );
      expect(pulledSha256).to.equal(
        sourceSha256,
        `round ${round}: pulled content mismatch`,
      );

      const mibPerSecond = (2 * fileSizeBytes) / MIB / (totalMs / 1000);
      roundStats.push({
        round,
        pushMs,
        pullMs,
        totalMs,
        mibPerSecond,
      });

      log.info(
        `Round ${round}/${iterations}: push ${pushMs.toFixed(0)}ms, pull ${pullMs.toFixed(0)}ms, ` +
          `total ${totalMs.toFixed(0)}ms (${mibPerSecond.toFixed(2)} MiB/s round-trip)`,
      );

      expect(totalMs).to.be.lessThan(
        maxRoundMs,
        `round ${round} exceeded ${maxRoundMs}ms budget`,
      );

      await logStep(round, 'cleanup.unlink', async () => {
        try {
          await fsp.unlink(pullPath);
        } catch {
          // ignore
        }
      });

      log.info(`round ${round}/${iterations} done`);
    }

    const avgRoundTrip =
      roundStats.reduce((sum, s) => sum + s.mibPerSecond, 0) /
      roundStats.length;
    const minRoundTrip = Math.min(...roundStats.map((s) => s.mibPerSecond));
    const maxRoundTrip = Math.max(...roundStats.map((s) => s.mibPerSecond));

    log.info(
      `Summary: ${iterations}/${iterations} ok; round-trip throughput ` +
        `min=${minRoundTrip.toFixed(2)} avg=${avgRoundTrip.toFixed(2)} max=${maxRoundTrip.toFixed(2)} MiB/s`,
    );
  });
});

const HEARTBEAT_MS = parsePositiveInt(
  process.env.AFC_STABILITY_HEARTBEAT_MS,
  5_000,
);

async function logStep<T>(
  round: number,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  log.info(`round ${round} >> ${step}`);
  try {
    const result = await fn();
    log.info(
      `round ${round} << ${step} (${(performance.now() - started).toFixed(0)}ms)`,
    );
    return result;
  } catch (err) {
    log.error(
      `round ${round} !! ${step} failed after ${(performance.now() - started).toFixed(0)}ms:`,
      err,
    );
    throw err;
  }
}

function attachTransferHeartbeat(
  round: number,
  step: string,
  stream: NodeJS.ReadableStream,
  label: string,
): void {
  let bytes = 0;
  let lastBeat = performance.now();
  stream.on('data', (chunk: Buffer | string) => {
    bytes +=
      typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    const now = performance.now();
    if (now - lastBeat >= HEARTBEAT_MS) {
      log.info(
        `round ${round} .. ${step} ${label} ${formatMiB(bytes)} transferred`,
      );
      lastBeat = now;
    }
  });
}

function attachAfcSocketDiagnostics(
  afc: AfcService,
  logger: ReturnType<typeof getLogger>,
): void {
  const hook = (socket: import('node:net').Socket, label: string) => {
    const startedAt = performance.now();
    let bytesIn = 0;
    let bytesOut = 0;
    socket.on('data', (chunk: Buffer) => {
      bytesIn += chunk.length;
    });
    const origWrite = socket.write.bind(socket);
    socket.write = ((...args: Parameters<typeof socket.write>) => {
      const chunk = args[0];
      if (Buffer.isBuffer(chunk)) {
        bytesOut += chunk.length;
      }
      return origWrite(...args);
    }) as typeof socket.write;

    for (const event of ['error', 'close', 'end', 'timeout'] as const) {
      socket.on(event, (...eventArgs: unknown[]) => {
        logger.warn(
          `AFC socket ${label} ${event} after ${(performance.now() - startedAt).toFixed(0)}ms ` +
            `(bytesIn=${formatMiB(bytesIn)} bytesOut=${formatMiB(bytesOut)} ` +
            `writableLength=${socket.writableLength} destroyed=${socket.destroyed})`,
          ...(event === 'error' ? eventArgs : []),
        );
      });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only hook into lazy connect
  const service = afc as any;
  const origConnect = service._connect.bind(service);
  service._connect = async () => {
    const socket = await origConnect();
    hook(socket, 'rsd-afc');
    return socket;
  };
}

async function pushWithSteps(
  afc: AfcService,
  round: number,
  localSrc: string,
  remoteDst: string,
  writeChunkBytes: number,
): Promise<void> {
  const handle = await logStep(round, 'push.fopen', () =>
    afc.fopen(remoteDst, 'w'),
  );
  try {
    const readStream = fs.createReadStream(localSrc, {
      highWaterMark: writeChunkBytes,
    });
    const writeStream = afc.createWriteStream(handle, writeChunkBytes);
    attachTransferHeartbeat(round, 'push.pipeline', readStream, 'uploaded');
    await logStep(round, 'push.pipeline', () =>
      pipeline(readStream, writeStream),
    );
  } catch (err) {
    await logStep(round, 'push.rmSingle (error cleanup)', () =>
      afc.rmSingle(remoteDst, true),
    );
    throw err;
  } finally {
    await logStep(round, 'push.fclose', () => afc.fclose(handle));
  }
}

async function pullWithSteps(
  afc: AfcService,
  round: number,
  remoteSrc: string,
  localDst: string,
): Promise<void> {
  const exists = await logStep(round, 'pull.exists', () =>
    afc.exists(remoteSrc),
  );
  if (!exists) {
    throw new Error(`Remote path does not exist: ${remoteSrc}`);
  }

  const isDir = await logStep(round, 'pull.isdir', () => afc.isdir(remoteSrc));
  if (isDir) {
    throw new Error(`Expected file, got directory: ${remoteSrc}`);
  }

  const st = await logStep(round, 'pull.stat', () => afc.stat(remoteSrc));
  if (st.st_ifmt !== AfcFileMode.S_IFREG) {
    throw new Error(`'${remoteSrc}' isn't a regular file`);
  }

  const handle = await logStep(round, 'pull.fopen', () =>
    afc.fopen(remoteSrc, 'r'),
  );
  try {
    const readStream = afc.createReadStream(handle, st.st_size);
    const writeStream = fs.createWriteStream(localDst);
    attachTransferHeartbeat(round, 'pull.pipeline', readStream, 'downloaded');
    await logStep(round, 'pull.pipeline', () =>
      pipeline(readStream, writeStream),
    );
  } finally {
    await logStep(round, 'pull.fclose', () => afc.fclose(handle));
  }
}

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
  const handle = await fsp.open(filePath, 'w');
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

async function sha256File(filePath: string): Promise<string> {
  const data = await fsp.readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}
