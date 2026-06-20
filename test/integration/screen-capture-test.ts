import { logger } from '@appium/support';
import { expect } from 'chai';
import { performance } from 'node:perf_hooks';

import type { ScreenCaptureService } from '../../src/index.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('ScreenCaptureService.test');
log.level = 'debug';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STREAMER_TEST_DURATION_MS = 5_000;

describe('DVT ScreenCaptureService', function () {
  this.timeout(60000);

  let screenCaptureService: ScreenCaptureService | null = null;
  const udid = process.env.UDID || '';

  before(async function () {
    if (!udid) {
      throw new Error('set UDID env var to execute tests.');
    }
    screenCaptureService = await Services.startScreenCaptureService(udid);
  });

  after(async function () {
    await screenCaptureService?.close();
  });

  it('should capture a screenshot and return PNG data', async function () {
    const result = await screenCaptureService!.captureScreenshot();

    expect(result.image).to.be.instanceOf(Buffer);
    expect(result.image.length).to.be.greaterThan(0);
    expect(result.image.subarray(0, PNG_MAGIC.length)).to.deep.equal(PNG_MAGIC);
    expect(result.imageFormat).to.equal('png');

    log.debug(
      `Captured DVT screenshot (${result.image.length} bytes)` +
        (result.displayUniqueID
          ? ` from display ${result.displayUniqueID}`
          : ''),
    );
  });

  it('should stream screenshots for 5 seconds and show max fps', async function () {
    const streamer = screenCaptureService!.createStreamer({ fps: 240 });
    const startedAt = performance.now();
    let frameCount = 0;
    let maxActualFps = 0;

    for await (const frame of streamer.frames()) {
      frameCount++;
      expect(frame.image).to.be.instanceOf(Buffer);
      expect(frame.image.length).to.be.greaterThan(0);
      expect(frame.image.subarray(0, PNG_MAGIC.length)).to.deep.equal(
        PNG_MAGIC,
      );

      maxActualFps = Math.max(maxActualFps, streamer.actualFps);
      if (performance.now() - startedAt >= STREAMER_TEST_DURATION_MS) {
        streamer.stop();
      }
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const averageFps = frameCount / elapsedSeconds;

    expect(frameCount).to.be.greaterThan(0);
    expect(maxActualFps).to.be.greaterThan(0);
    log.info(
      `Streamer captured ${frameCount} frames in ${elapsedSeconds.toFixed(2)}s; ` +
        `avg=${averageFps.toFixed(2)} fps max=${maxActualFps.toFixed(2)} fps`,
    );
  });
});
