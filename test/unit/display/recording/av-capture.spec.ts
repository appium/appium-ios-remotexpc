import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';
import {recordScreenAndAudioToFiles} from '../../../../src/services/ios/display/recording/av-capture.js';

/** A stub service that negotiates without a device and counts teardowns. */
function makeStubService(): {service: DisplayService; stopCalls: () => number} {
  let stopCalls = 0;
  // An empty streamConfig means no RTCP identity, so no keepalive timer is
  // started — the negotiation is all this test needs.
  const answer = {
    clientSessionId: undefined,
    streamConfig: {},
    connection: {},
    raw: {},
  } as unknown as MediaStreamAnswer;
  const service = {
    getTunnelLocalAddress: async (): Promise<string> => '::1',
    getDeviceAddress: async (): Promise<string> => '::1',
    startVideoStream: async (): Promise<MediaStreamAnswer> => answer,
    startAudioStream: async (): Promise<MediaStreamAnswer> => answer,
    stopAllMediaStreams: async (): Promise<number[]> => {
      stopCalls += 1;
      return [];
    },
  } as unknown as DisplayService;
  return {service, stopCalls: () => stopCalls};
}

describe('recordScreenAndAudioToFiles', function () {
  let directory: string;

  before(async function () {
    directory = await mkdtemp(join(tmpdir(), 'record-av-'));
  });

  after(async function () {
    await rm(directory, {force: true, recursive: true});
  });

  it('stops both captures when the audio file cannot be created', async function () {
    // Both captures are streaming before either writer is opened, so a failing
    // audio writer used to strand two live device streams plus the video file
    // descriptor. None of them escape the function, so no caller could release
    // them.
    const {service, stopCalls} = makeStubService();

    await assert.rejects(
      () =>
        recordScreenAndAudioToFiles(service, {
          videoPath: join(directory, 'screen.h265'),
          audioPath: join(directory, 'no', 'such', 'dir', 'audio.m4a'),
        }),
      /ENOENT/,
    );

    assert.strictEqual(stopCalls(), 2, 'both captures must be stopped before the error propagates');
  });
});
