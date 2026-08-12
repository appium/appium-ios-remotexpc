import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type TestContext, after, before, describe, it} from 'node:test';

import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';
import {recordScreenAndAudioToFiles} from '../../../../src/services/ios/display/recording/av-capture.js';
import {mockImport} from '../../../helpers/mock-module.js';

const AV_CAPTURE_MODULE = '../../../../src/services/ios/display/recording/av-capture.js';
const M4A_WRITER_MODULE = '../../../../src/services/ios/display/audio/m4a-writer.js';
const SCREEN_CAPTURE_MODULE = '../../../../src/services/ios/display/video/screen-stream-capture.js';

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

  it('closes the video writer even when closing the audio writer throws', async function (t: TestContext) {
    // M4aFileWriter finalizes by reopening the finished file to patch mdat's
    // length, so it can fail on a full disk after every frame is already on
    // disk. Sequencing the closes would skip the video one, leaking its file
    // descriptor and leaving the error its stream holds unread.
    let videoCloseCalls = 0;
    const closeFailure = new Error('failed to patch the mdat header');

    class StubM4aFileWriter {
      static async create(): Promise<StubM4aFileWriter> {
        return new StubM4aFileWriter();
      }
      async write(): Promise<void> {
        return undefined;
      }
      async close(): Promise<never> {
        throw closeFailure;
      }
    }

    class StubAnnexBFileWriter {
      constructor(path: string) {
        void path;
      }
      async write(): Promise<void> {
        return undefined;
      }
      async close(): Promise<void> {
        videoCloseCalls += 1;
      }
    }

    const {recordScreenAndAudioToFiles: record} = await mockImport<{
      recordScreenAndAudioToFiles: typeof recordScreenAndAudioToFiles;
    }>(t, AV_CAPTURE_MODULE, import.meta.url, {
      [M4A_WRITER_MODULE]: {M4aFileWriter: StubM4aFileWriter},
      // Merged over the real exports, so ScreenStreamCapture stays intact.
      [SCREEN_CAPTURE_MODULE]: {AnnexBFileWriter: StubAnnexBFileWriter},
    });

    const {service} = makeStubService();
    await assert.rejects(
      () =>
        record(service, {
          videoPath: join(directory, 'screen-close.h265'),
          audioPath: join(directory, 'audio-close.m4a'),
          durationMs: 50,
        }),
      /failed to patch the mdat header/,
    );

    assert.strictEqual(videoCloseCalls, 1, 'the video writer must be closed even though the audio close threw');
  });
});
