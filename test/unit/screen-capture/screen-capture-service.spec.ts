import { expect } from 'chai';

import {
  type CaptureScreenshotResult,
  ScreenCaptureService,
} from '../../../src/services/ios/screen-capture/index.js';

class TestScreenCaptureService extends ScreenCaptureService {
  constructor(
    private readonly image: Buffer,
    private readonly requestedImages: Buffer[] = [],
  ) {
    super('test-udid');
  }

  protected async getScreenshotInstrument(): Promise<any> {
    return {
      getScreenshot: async (): Promise<Buffer> => {
        this.requestedImages.push(this.image);
        return this.image;
      },
    };
  }
}

describe('ScreenCaptureService', function () {
  it('returns DVT screenshot PNG bytes with metadata', async function () {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const requestedImages: Buffer[] = [];
    const service = new TestScreenCaptureService(image, requestedImages);

    const result: CaptureScreenshotResult = await service.captureScreenshot({
      displayUniqueId: 'main',
    });

    expect(result).to.deep.equal({
      image,
      displayUniqueID: 'main',
      imageFormat: 'png',
    });
    expect(requestedImages).to.deep.equal([image]);
  });

  it('rejects non-PNG formats', async function () {
    const service = new TestScreenCaptureService(Buffer.alloc(0));

    let caught: Error | undefined;
    try {
      await service.captureScreenshot({ requestedFormat: 'jpeg' });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).to.equal(
      'DVT screenshot service only supports PNG output',
    );
  });
});
