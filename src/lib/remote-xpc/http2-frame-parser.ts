import { WindowUpdateFrame } from './handshake-frames.js';

const FRAME_HEADER_SIZE = 9;
const FRAME_TYPE_DATA = 0x00;
const FLAG_PADDED = 0x08;

export interface ParsedDataFrame {
  readonly streamId: number;
  readonly data: Buffer;
  readonly bodyLen: number;
}

export type ParsedFrame =
  | { readonly type: 'data'; readonly frame: ParsedDataFrame }
  | { readonly type: 'other' };

/**
 * Incrementally parse HTTP/2 frames from a byte stream (RFC 7540).
 */
export class Http2FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): ParsedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ParsedFrame[] = [];

    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const length =
        (this.buffer[0] << 16) |
        (this.buffer[1] << 8) |
        this.buffer[2];
      const totalSize = FRAME_HEADER_SIZE + length;
      if (this.buffer.length < totalSize) {
        break;
      }

      const frameBuffer = this.buffer.subarray(0, totalSize);
      this.buffer = this.buffer.subarray(totalSize);
      frames.push(parseFrame(frameBuffer));
    }

    return frames;
  }
}

/**
 * Emit WINDOW_UPDATE frames for even-numbered streams, matching `remoted` behavior.
 */
export function buildWindowUpdateFrames(
  streamId: number,
  increment: number,
): Buffer[] {
  if (streamId % 2 !== 0 || increment <= 0) {
    return [];
  }
  return [
    new WindowUpdateFrame(0, increment).serialize(),
    new WindowUpdateFrame(streamId, increment).serialize(),
  ];
}

function parseFrame(buffer: Buffer): ParsedFrame {
  const length =
    (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];
  const type = buffer[3];
  const flags = buffer[4];
  const streamId = buffer.readUInt32BE(5) & 0x7fffffff;
  const body = buffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length);

  if (type !== FRAME_TYPE_DATA) {
    return { type: 'other' };
  }

  let data = body;
  if (flags & FLAG_PADDED) {
    const padLength = body[0] ?? 0;
    data = body.subarray(1, body.length - padLength);
  }

  return {
    type: 'data',
    frame: { streamId, data, bodyLen: length },
  };
}
