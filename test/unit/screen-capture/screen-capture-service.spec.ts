import { expect } from 'chai';

import {
  type CaptureScreenshotResult,
  ScreenCaptureService,
} from '../../../src/services/ios/screen-capture/index.js';

class TestScreenCaptureService extends ScreenCaptureService {
  closeCalls = 0;

  constructor(
    private readonly image: Buffer,
    private readonly requestedImages: Buffer[] = [],
  ) {
    super('test-udid');
  }

  protected async getScreenshotInstrument(): Promise<any> {
    return {
      initialize: async (): Promise<void> => {},
      takeScreenshot: async (): Promise<Buffer> => {
        this.requestedImages.push(this.image);
        return this.image;
      },
    };
  }

  override async close(): Promise<void> {
    this.closeCalls++;
    await super.close();
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

  it('streams screenshots until aborted', async function () {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const requestedImages: Buffer[] = [];
    const service = new TestScreenCaptureService(image, requestedImages);
    const streamer = service.createStreamer({ fps: 240 });
    const frames: CaptureScreenshotResult[] = [];

    for await (const frame of streamer.frames()) {
      frames.push(frame);
      if (frames.length === 3) {
        streamer.stop();
      }
    }

    expect(frames).to.have.length(3);
    expect(frames.map((frame) => frame.image)).to.deep.equal([
      image,
      image,
      image,
    ]);
    expect(streamer.actualFps).to.be.greaterThan(0);
    expect(requestedImages).to.have.length(3);
  });

  it('allows one active streamer at a time', async function () {
    const service = new TestScreenCaptureService(Buffer.alloc(0));
    const streamer = service.createStreamer({ fps: 1 });

    expect(service.getActiveStreamer()).to.equal(streamer);
    expect(() => service.createStreamer({ fps: 1 })).to.throw(
      'A screen capture streamer is already active',
    );

    streamer.stop();
    expect(service.getActiveStreamer()).to.equal(null);
    expect(service.createStreamer({ fps: 1 })).to.exist;
  });

  it('supports dynamic fps updates', async function () {
    const service = new TestScreenCaptureService(Buffer.alloc(0));
    const streamer = service.createStreamer({ fps: 1 });
    const stream = streamer.frames();

    expect(streamer.fps).to.equal(1);
    expect((await stream.next()).done).to.equal(false);

    const waitingFrame = stream.next();
    expect(await settlesWithin(waitingFrame, 20)).to.equal(false);

    streamer.fps = 240;
    expect(streamer.fps).to.equal(240);
    expect((await waitingFrame).done).to.equal(false);
    streamer.stop();
  });

  it('supports pause and resume', async function () {
    const service = new TestScreenCaptureService(Buffer.alloc(0));
    const streamer = service.createStreamer({ fps: 240 });
    const stream = streamer.frames();

    expect((await stream.next()).done).to.equal(false);

    streamer.pause();
    expect(streamer.isPaused).to.equal(true);

    const waitingFrame = stream.next();
    expect(await settlesWithin(waitingFrame, 20)).to.equal(false);

    streamer.resume();
    expect(streamer.isPaused).to.equal(false);
    expect((await waitingFrame).done).to.equal(false);
    streamer.stop();
  });

  it('stops active screenshot streams when the service is closed', async function () {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const service = new TestScreenCaptureService(image);
    const streamer = service.createStreamer({ fps: 1 });
    const stream = streamer.frames();

    const first = await stream.next();
    expect(first.done).to.equal(false);

    const next = stream.next();
    await service.close();

    expect(await next).to.deep.equal({ value: undefined, done: true });
    expect(service.closeCalls).to.equal(1);
    expect(streamer.isStopped).to.equal(true);
  });

  it('rejects invalid stream frame rates', async function () {
    const service = new TestScreenCaptureService(Buffer.alloc(0));

    expect(service.createStreamer({ fps: 240 })).to.exist;
    service.getActiveStreamer()?.stop();

    expect(() => service.createStreamer({ fps: 0 })).to.throw(
      'fps must be a positive finite number not greater than 240. Got 0',
    );
    expect(() => service.createStreamer({ fps: 241 })).to.throw(
      'fps must be a positive finite number not greater than 240. Got 241',
    );
  });
});

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}
