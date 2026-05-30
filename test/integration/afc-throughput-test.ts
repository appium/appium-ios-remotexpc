import { expect } from 'chai';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Services } from '../../src/index.js';

/**
 * AFC bulk-transfer throughput / stall diagnostic.
 *
 * Reproduces and measures the large-app AFC push freeze reported in
 * https://github.com/appium/appium-ios-remotexpc/issues/208 by pushing
 * dummy files of increasing size and reporting:
 *   - wall-clock time + throughput (MB/s)
 *   - live DEVICE-ACKED progress (via writeFromStream's onProgress hook, which
 *     fires only after each WRITE is acknowledged by the device — so it tracks
 *     real progress, not bytes merely buffered on the host)
 *   - a watchdog that ABORTS the push on a full stall (STALL_MS) or sustained
 *     low throughput (avg < MIN_MBPS after GRACE_MS)
 *
 * The content is irrelevant (AFC does not compress), so we push zero-filled
 * files — no real .ipa or signing required. Each size uses its OWN fresh AFC
 * connection so an aborted push cannot desync the socket for the next size.
 *
 * Env knobs: SIZES_MB, WRITE_CHUNK_MB (override AFC write chunk), STALL_MS,
 * GRACE_MS, MIN_MBPS.
 *
 * Run (with the tunnel up):
 *   UDID=<udid> SIZES_MB=10,30,60,100 sudo -E npx mocha \
 *     test/integration/afc-throughput-test.ts --exit --timeout 20m
 */
describe('AFC throughput / stall diagnostic', function () {
  const udid = process.env.UDID || '';
  const sizesMb = (process.env.SIZES_MB || '10,30,60,100')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  // Override the AFC write chunk size (MiB); undefined = library default.
  const writeChunkMb = process.env.WRITE_CHUNK_MB
    ? Number(process.env.WRITE_CHUNK_MB)
    : undefined;
  // Abort only on a genuine hang: no acked progress at all for this long (ms).
  // We do NOT abort on low throughput — the tunnel is genuinely slow and bursty
  // (a 4 MiB write can take ~20s+ to drain), and a slow-but-progressing push is
  // exactly what we want to measure, not fail.
  const stallMs = Number(process.env.STALL_MS || 60_000);

  before(function () {
    if (!udid) {
      throw new Error('UDID env var is required');
    }
  });

  for (const sizeMb of sizesMb) {
    it(`should push a ${sizeMb} MB file and report throughput`, async function () {
      const totalBytes = sizeMb * 1024 * 1024;
      // Backstop timeout: pessimistic ~0.1 MB/s floor, min 2 min. The watchdog
      // is what fails a genuine hang fast; this only guards a slow crawl.
      this.timeout(Math.max(120_000, sizeMb * 10_000));

      const localPath = path.join(os.tmpdir(), `afc_thru_${sizeMb}mb.bin`);
      const remotePath = `/Downloads/afc_thru_${sizeMb}mb_${Date.now()}.bin`;

      // Generate the dummy file (zero-filled).
      await fsp.writeFile(localPath, Buffer.alloc(totalBytes));

      // A fresh connection per size isolates an aborted push from later sizes.
      const afc = await Services.startAfcService(udid);

      let written = 0; // device-acked bytes (from onProgress)
      let lastProgressAt = Date.now();
      let lastLogged = 0;
      let aborted = false;

      const fileStream = fs.createReadStream(localPath);
      const start = Date.now();
      let lastLogAt = start;

      const watchdog = setInterval(() => {
        const now = Date.now();
        const sinceProgress = now - lastProgressAt;
        // Log only when a chunk is acked, or as an occasional heartbeat during a
        // long device-side gap — not on every tick.
        const progressed = written > lastLogged;
        if (progressed || now - lastLogAt >= 15_000) {
          const pct = ((written / totalBytes) * 100).toFixed(0);
          const mb = (written / 1024 / 1024).toFixed(0);
          // eslint-disable-next-line no-console
          console.log(
            `[${sizeMb}MB] ${mb}/${sizeMb} MB (${pct}%)` +
              (progressed
                ? ''
                : `  waiting ${(sinceProgress / 1000).toFixed(0)}s`),
          );
          lastLogged = written;
          lastLogAt = now;
        }
        if (sinceProgress >= stallMs && written < totalBytes && !aborted) {
          aborted = true;
          const reason = `no acked progress for ${(
            sinceProgress / 1000
          ).toFixed(0)}s`;
          // eslint-disable-next-line no-console
          console.error(
            `[${sizeMb}MB] ABORT (${reason}) at ${written}/${totalBytes} ` +
              `bytes acked`,
          );
          clearInterval(watchdog);
          // Destroying the source rejects the pipeline inside writeFromStream,
          // so the push fails fast instead of hanging to the backstop timeout.
          fileStream.destroy(
            new Error(`AFC push aborted (${reason}) at ${written} bytes`),
          );
        }
      }, 1_000);

      try {
        await afc.writeFromStream(remotePath, fileStream, {
          chunkSize: writeChunkMb ? writeChunkMb * 1024 * 1024 : undefined,
          onProgress: (b) => {
            written = b;
            lastProgressAt = Date.now();
          },
        });

        const elapsedMs = Date.now() - start;
        const throughput = totalBytes / 1024 / 1024 / (elapsedMs / 1000);
        // eslint-disable-next-line no-console
        console.log(
          `[${sizeMb}MB] DONE in ${(elapsedMs / 1000).toFixed(1)}s => ` +
            `${throughput.toFixed(2)} MB/s` +
            (writeChunkMb ? ` (chunk ${writeChunkMb} MB)` : ''),
        );

        // Verify the device actually received the full file.
        const stat = await afc.stat(remotePath);
        expect(stat.st_size).to.equal(BigInt(totalBytes));
        expect(aborted, 'transfer aborted mid-push').to.equal(false);
      } finally {
        clearInterval(watchdog);
        if (!fileStream.destroyed) {
          fileStream.destroy();
        }
        try {
          await afc.rm(remotePath);
        } catch {
          // ignore
        }
        try {
          afc.close();
        } catch {
          // ignore
        }
        try {
          await fsp.unlink(localPath);
        } catch {
          // ignore
        }
      }
    });
  }
});
