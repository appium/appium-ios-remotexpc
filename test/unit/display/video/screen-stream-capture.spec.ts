import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';
import {ScreenStreamCapture} from '../../../../src/services/ios/display/video/screen-stream-capture.js';

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
