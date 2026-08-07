import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {ffmpegMuxCommandBuilder, formatMuxCommand} from '../../../../src/services/ios/display/recording/mux-command.js';

const INPUT = {videoPath: '/tmp/screen.h265', audioPath: '/tmp/screen.m4a', frameRate: 28.793};

/** Returns the argument immediately following `flag`. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe('ffmpegMuxCommandBuilder', function () {
  describe('command shape', function () {
    it('defaults to the ffmpeg binary and allows overriding it', function () {
      assert.strictEqual(ffmpegMuxCommandBuilder.build(INPUT).binary, 'ffmpeg');
      assert.strictEqual(
        ffmpegMuxCommandBuilder.build(INPUT, '/opt/homebrew/bin/ffmpeg').binary,
        '/opt/homebrew/bin/ffmpeg',
      );
    });

    it('passes each path as its own argument, with no quoting', function () {
      const {args} = ffmpegMuxCommandBuilder.build(INPUT);

      // Whole-element equality is the point of the argv form: a path is never
      // wrapped in quotes that a caller would have to strip before spawn().
      assert.ok(args.includes(INPUT.videoPath));
      assert.ok(args.includes(INPUT.audioPath));
    });

    it('carries the measured frame rate', function () {
      const {args} = ffmpegMuxCommandBuilder.build(INPUT);

      assert.strictEqual(valueAfter(args, '-r'), '28.793');
    });

    it('places -r before the video input, where it applies to decoding', function () {
      const {args} = ffmpegMuxCommandBuilder.build(INPUT);

      // After the input it would be an output option and the timing would be
      // wrong, so the ordering is load-bearing rather than cosmetic.
      assert.ok(args.indexOf('-r') < args.indexOf('-i'));
    });

    it('remuxes without re-encoding and tags the video as hvc1', function () {
      const {args} = ffmpegMuxCommandBuilder.build(INPUT);

      assert.strictEqual(valueAfter(args, '-c'), 'copy');
      assert.strictEqual(valueAfter(args, '-tag:v'), 'hvc1');
      assert.strictEqual(valueAfter(args, '-fflags'), '+genpts');
    });

    it('maps one stream from each input', function () {
      const {args} = ffmpegMuxCommandBuilder.build(INPUT);

      const maps = args.filter((_, i) => args[i - 1] === '-map');
      assert.deepStrictEqual(maps, ['0:v:0', '1:a:0']);
    });
  });

  describe('output path', function () {
    it('derives an .mp4 beside the video by default', function () {
      const command = ffmpegMuxCommandBuilder.build(INPUT);

      assert.strictEqual(command.outputPath, '/tmp/screen.mp4');
      assert.strictEqual(command.args.at(-1), '/tmp/screen.mp4');
    });

    it('appends the extension when the video path has none', function () {
      const command = ffmpegMuxCommandBuilder.build({...INPUT, videoPath: '/tmp/screen'});

      assert.strictEqual(command.outputPath, '/tmp/screen.mp4');
    });

    it('does not mistake a dotted directory for an extension', function () {
      const command = ffmpegMuxCommandBuilder.build({...INPUT, videoPath: '/tmp/v1.2/screen'});

      assert.strictEqual(command.outputPath, '/tmp/v1.2/screen.mp4');
    });

    it('honours an explicit output path', function () {
      const command = ffmpegMuxCommandBuilder.build({...INPUT, outputPath: '/out/combined.mov'});

      assert.strictEqual(command.outputPath, '/out/combined.mov');
      assert.strictEqual(command.args.at(-1), '/out/combined.mov');
    });
  });
});

describe('formatMuxCommand', function () {
  it('renders a plain command without needless quoting', function () {
    const rendered = formatMuxCommand(ffmpegMuxCommandBuilder.build(INPUT));

    assert.ok(rendered.startsWith('ffmpeg -y -fflags +genpts -r 28.793 -i /tmp/screen.h265'));
    assert.ok(!rendered.includes("'"));
  });

  it('quotes paths containing spaces', function () {
    const rendered = formatMuxCommand(
      ffmpegMuxCommandBuilder.build({...INPUT, videoPath: '/tmp/my recordings/screen.h265'}),
    );

    assert.ok(rendered.includes("'/tmp/my recordings/screen.h265'"));
  });

  it('escapes an embedded single quote', function () {
    // The old string-building version produced a command that broke here.
    const rendered = formatMuxCommand(
      ffmpegMuxCommandBuilder.build({...INPUT, videoPath: "/tmp/nav's clips/screen.h265"}),
    );

    assert.ok(rendered.includes(`'/tmp/nav'\\''s clips/screen.h265'`));
  });
});
