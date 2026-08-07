/**
 * Commands for combining a screen recording's two tracks into one file.
 *
 * Muxing is deliberately not performed here: it needs no device access, and
 * callers differ on container, timing and post-processing. What this library
 * does own is the knowledge of *how* the tracks have to be described — the
 * Annex-B video carries no timestamps, so the measured frame rate has to be
 * supplied explicitly or the result plays at the wrong speed.
 *
 * So a builder returns the binary and its argument vector rather than a shell
 * string. That is what an external tool actually needs: `child_process.spawn`
 * and `teen_process.exec` both take an argv, no quoting rules are involved, and
 * a caller whose `ffmpeg` lives somewhere unusual can substitute the binary
 * without re-parsing anything. {@link formatMuxCommand} renders the same
 * command for a human when one needs to be printed or copied into a terminal.
 */

/** The two tracks a recording produced, plus what a muxer must be told. */
export interface MuxInput {
  /** Path to the Annex-B HEVC elementary stream. */
  videoPath: string;
  /** Path to the AAC-ELD `.m4a`. */
  audioPath: string;
  /**
   * Frames per second measured over the capture window.
   *
   * Required: the video stream has no timing of its own, so this is the only
   * thing that fixes playback speed.
   */
  frameRate: number;
  /** Output file. Defaults to the video path with an `.mp4` extension. */
  outputPath?: string;
}

/** A command to run, as a binary plus its arguments. */
export interface MuxCommand {
  /** Executable name or path. */
  binary: string;
  /** Arguments, already split — no shell quoting is applied or needed. */
  args: string[];
  /** Where the command will write its output. */
  outputPath: string;
}

/** Builds a mux command for one backend. */
export interface MuxCommandBuilder {
  /** Backend name, e.g. `ffmpeg`. */
  readonly name: string;
  /** Default executable, overridable per call. */
  readonly defaultBinary: string;
  /**
   * Produces the command for this input.
   *
   * @param input The tracks and the measured frame rate.
   * @param binary Executable to invoke; defaults to {@link defaultBinary}.
   */
  build(input: MuxInput, binary?: string): MuxCommand;
}

/** Replaces the file extension, appending one when there is none. */
function withExtension(path: string, extension: string): string {
  return /\.[^./\\]+$/.test(path) ? path.replace(/\.[^./\\]+$/, extension) : path + extension;
}

/**
 * Builds an `ffmpeg` invocation that remuxes the two tracks into an MP4 without
 * re-encoding either.
 *
 * The flags are not arbitrary:
 * - `-fflags +genpts` with an explicit `-r` before the video input, because the
 *   Annex-B stream has no timestamps — without them ffmpeg produces a file with
 *   an empty audio track.
 * - `-c copy`, so the AAC-ELD never has to be decoded. Most decoders get ELD
 *   wrong (see `aac-eld.ts`), and copying sidesteps the question entirely.
 * - `-tag:v hvc1` rather than the default `hev1`, which is what makes the
 *   result playable in QuickTime and Safari.
 */
export const ffmpegMuxCommandBuilder: MuxCommandBuilder = {
  name: 'ffmpeg',
  defaultBinary: 'ffmpeg',

  build(input: MuxInput, binary: string = 'ffmpeg'): MuxCommand {
    const {videoPath, audioPath, frameRate} = input;
    const outputPath = input.outputPath ?? withExtension(videoPath, '.mp4');
    return {
      binary,
      args: [
        '-y',
        '-fflags',
        '+genpts',
        '-r',
        String(frameRate),
        '-i',
        videoPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-tag:v',
        'hvc1',
        outputPath,
      ],
      outputPath,
    };
  },
};

/** Quotes one argument for a POSIX shell, only when it needs it. */
function shellQuote(argument: string): string {
  if (/^[\w./:=@%+-]+$/.test(argument)) {
    return argument;
  }
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * Renders a command as a copy-pasteable POSIX shell line.
 *
 * For display and logging only — to actually run the command, pass
 * {@link MuxCommand.binary} and {@link MuxCommand.args} to `spawn`, which needs
 * no quoting at all.
 */
export function formatMuxCommand(command: MuxCommand): string {
  return [command.binary, ...command.args].map(shellQuote).join(' ');
}
