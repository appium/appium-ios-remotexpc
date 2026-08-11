import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';
import {
  AnnexBFileWriter,
  ScreenStreamCapture,
} from '../../../../src/services/ios/display/video/screen-stream-capture.js';

/**
 * Builds a capture wired to a stub service and a stub receiver, bypassing
 * `start()` (which would negotiate with a device).
 */
function makeCapture(options: {onStop: () => Promise<void>}): {
  capture: ScreenStreamCapture;
  receiverCloseCalls: () => number;
} {
  let receiverClosed = 0;
  const service = {
    stopAllMediaStreams: async (): Promise<number[]> => {
      await options.onStop();
      return [];
    },
  } as unknown as DisplayService;
  const receiver = {
    close: (): void => {
      receiverClosed += 1;
    },
    async *packets(): AsyncGenerator<Buffer, void, unknown> {
      // No traffic in these tests.
    },
    port: 1234,
  };
  const answer = {
    clientSessionId: undefined,
    streamConfig: {},
    connection: {},
    raw: {},
  } as unknown as MediaStreamAnswer;

  // The constructor is private by design; tests build the object directly.
  const capture = Reflect.construct(ScreenStreamCapture, [service, receiver, answer]) as ScreenStreamCapture;
  return {capture, receiverCloseCalls: () => receiverClosed};
}

describe('ScreenStreamCapture', function () {
  describe('stop()', function () {
    it('tears the stream down exactly once across repeated calls', async function () {
      let stopCalls = 0;
      const {capture, receiverCloseCalls} = makeCapture({
        onStop: async () => {
          stopCalls += 1;
        },
      });

      await capture.stop();
      await capture.stop();
      await capture.stop();

      assert.strictEqual(stopCalls, 1);
      assert.strictEqual(receiverCloseCalls(), 1);
    });

    it('makes a concurrent caller await the in-flight teardown, not return early', async function () {
      // The regression this guards: `recordScreenToFile` triggers stop() from a
      // timer and again from its finally block. If the second call returned
      // early, the function could resolve while the device-side stop was still
      // in flight — and the transport it then created outlived the service's
      // close(), leaking a socket that kept the process alive.
      let released: () => void = () => undefined;
      let settled = false;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      const {capture} = makeCapture({onStop: () => gate});

      const first = capture.stop().then(() => {
        settled = true;
      });
      const second = capture.stop();

      // Neither call may resolve while the teardown is still blocked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(settled, false);

      released();
      await Promise.all([first, second]);
      assert.strictEqual(settled, true);
    });

    it('propagates a teardown failure to every caller', async function () {
      const {capture} = makeCapture({
        onStop: async () => {
          throw new Error('device refused the stop');
        },
      });

      const first = capture.stop();
      const second = capture.stop();

      for (const pending of [first, second]) {
        let caught: unknown;
        try {
          await pending;
        } catch (error) {
          caught = error;
        }
        assert.strictEqual((caught as Error | undefined)?.message, 'device refused the stop');
      }
    });
  });
});

describe('AnnexBFileWriter', function () {
  let directory: string;
  let counter = 0;

  before(async function () {
    directory = await mkdtemp(join(tmpdir(), 'annexb-writer-'));
  });

  after(async function () {
    await rm(directory, {force: true, recursive: true});
  });

  const chunk = (byte: number, length: number): Buffer => Buffer.alloc(length, byte);
  const missingPath = (): string => join(directory, 'no', 'such', 'dir', 'screen.h265');

  it('writes every chunk through to the file', async function () {
    const path = join(directory, `stream-${counter++}.h265`);
    const chunks = [chunk(0x11, 40), chunk(0x22, 55), chunk(0x33, 48)];

    const writer = new AnnexBFileWriter(path);
    for (const part of chunks) {
      await writer.write(part);
    }
    await writer.close();

    assert.deepStrictEqual(await readFile(path), Buffer.concat(chunks));
  });

  it('writes a file larger than the stream buffer, so backpressure is exercised', async function () {
    const path = join(directory, `stream-${counter++}.h265`);
    const frame = chunk(0xab, 256 * 1024);
    const frames = 40;

    const writer = new AnnexBFileWriter(path);
    for (let i = 0; i < frames; i++) {
      await writer.write(frame);
    }
    await writer.close();

    const file = await readFile(path);
    assert.strictEqual(file.length, frame.length * frames);
    assert.ok(file.every((byte) => byte === 0xab));
  });

  it('reports a bad output path as a rejection rather than an uncaught error', async function () {
    // A stream 'error' with no listener is an uncaught exception, which during
    // an unattended recording would take the whole process down. The open
    // failure lands asynchronously, so it surfaces from whichever call runs
    // once it has — a later write, or the close in the recorder's finally.
    const writer = new AnnexBFileWriter(missingPath());

    await assert.rejects(async () => {
      await writer.write(chunk(0x11, 40));
      await writer.close();
    }, /ENOENT/);
  });

  it('reports a bad output path from close() when no write ever ran', async function () {
    // The recorder writes nothing until the first keyframe arrives, so a
    // capture that is torn down early reaches close() having never written.
    // close() must still name the real cause, not a generic stream error.
    const writer = new AnnexBFileWriter(missingPath());

    await assert.rejects(() => writer.close(), /ENOENT/);
  });

  it('surfaces a write failure through the next call', async function () {
    const writer = new AnnexBFileWriter(join(directory, `stream-${counter++}.h265`));
    await writer.write(chunk(0x11, 40));

    // Stand in for a disk filling up mid-recording.
    (writer as unknown as {streamError: Error}).streamError = new Error('ENOSPC');

    await assert.rejects(() => writer.write(chunk(0x22, 40)), /ENOSPC/);
    await assert.rejects(() => writer.close(), /ENOSPC/);
  });
});
