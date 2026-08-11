import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import {recordAudioToFile} from '../../../../src/services/ios/display/audio/audio-stream-capture.js';
import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';

/** A stub service that negotiates without a device and counts teardowns. */
function makeStubService(): {service: DisplayService; stopCalls: () => number} {
  let stopCalls = 0;
  const service = {
    getTunnelLocalAddress: async (): Promise<string> => '::1',
    getDeviceAddress: async (): Promise<string> => '::1',
    startAudioStream: async (): Promise<MediaStreamAnswer> =>
      // An empty streamConfig means no RTCP identity, so no keepalive timer is
      // started — the negotiation is all this test needs.
      ({clientSessionId: undefined, streamConfig: {}, connection: {}, raw: {}}) as unknown as MediaStreamAnswer,
    stopAllMediaStreams: async (): Promise<number[]> => {
      stopCalls += 1;
      return [];
    },
  } as unknown as DisplayService;
  return {service, stopCalls: () => stopCalls};
}

describe('recordAudioToFile', function () {
  let directory: string;

  before(async function () {
    directory = await mkdtemp(join(tmpdir(), 'record-audio-'));
  });

  after(async function () {
    await rm(directory, {force: true, recursive: true});
  });

  it('stops the capture when the output file cannot be created', async function () {
    // The capture is started before the writer, so a writer that fails to open
    // used to strand a live device stream: nothing stopped it, its UDP receiver
    // stayed bound, and its queue grew with every packet nobody read. The
    // capture never escapes the function, so no caller could clean it up.
    const {service, stopCalls} = makeStubService();
    const unwritablePath = join(directory, 'no', 'such', 'dir', 'audio.m4a');

    await assert.rejects(() => recordAudioToFile(service, unwritablePath), /ENOENT/);

    assert.strictEqual(stopCalls(), 1, 'the capture must be stopped before the error propagates');
  });
});
