import { logger } from '@appium/support';
import { expect } from 'chai';

import type { ScreenCaptureService } from '../../src/index.js';
import * as Services from '../../src/services.js';

const log = logger.getLogger('ScreenCaptureService.test');
log.level = 'debug';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('CoreDevice ScreenCaptureService', function () {
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
      `Captured CoreDevice screenshot (${result.image.length} bytes)` +
        (result.displayUniqueID
          ? ` from display ${result.displayUniqueID}`
          : ''),
    );
  });
});
