import {Http2Constants} from './constants.js';
import {InvalidDataError, WindowUpdateFrame} from './handshake-frames.js';

const FRAME_HEADER_SIZE = 9;
const FRAME_TYPE_DATA = 0x00;
const FRAME_TYPE_SETTINGS = 0x04;
const FRAME_TYPE_WINDOW_UPDATE = 0x08;
const FLAG_PADDED = 0x08;
const SETTINGS_ENTRY_SIZE = 6;

export interface ParsedDataFrame {
  readonly streamId: number;
  readonly data: Buffer;
  readonly bodyLen: number;
}

export type ParsedFrame =
  | {readonly type: 'data'; readonly frame: ParsedDataFrame}
  | {readonly type: 'settings'; readonly settings: Record<number, number>}
  | {readonly type: 'windowUpdate'; readonly streamId: number; readonly increment: number}
  | {readonly type: 'other'};

/**
 * Incrementally parse HTTP/2 frames from a byte stream (RFC 7540).
 */
export class Http2FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): ParsedFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ParsedFrame[] = [];

    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const length = (this.buffer[0] << 16) | (this.buffer[1] << 8) | this.buffer[2];
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
export function buildWindowUpdateFrames(streamId: number, increment: number): Buffer[] {
  if (streamId % 2 !== 0 || increment <= 0) {
    return [];
  }
  return [new WindowUpdateFrame(0, increment).serialize(), new WindowUpdateFrame(streamId, increment).serialize()];
}

function parseFrame(buffer: Buffer): ParsedFrame {
  const length = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];
  const type = buffer[3];
  const flags = buffer[4];
  const streamId = buffer.readUInt32BE(5) & 0x7fffffff;
  const body = buffer.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length);

  if (type === FRAME_TYPE_SETTINGS && !(flags & Http2Constants.FLAG_ACK)) {
    return {type: 'settings', settings: parseSettings(body)};
  }
  if (type === FRAME_TYPE_WINDOW_UPDATE) {
    return {type: 'windowUpdate', streamId, increment: body.readUInt32BE(0) & 0x7fffffff};
  }
  if (type !== FRAME_TYPE_DATA) {
    return {type: 'other'};
  }

  const data = stripDataFramePadding(body, flags);

  return {
    type: 'data',
    frame: {streamId, data, bodyLen: length},
  };
}

/** SETTINGS body is a list of 16-bit identifier / 32-bit value pairs (RFC 7540 §6.5.1). */
function parseSettings(body: Buffer): Record<number, number> {
  return Object.fromEntries(
    Array.from({length: Math.floor(body.length / SETTINGS_ENTRY_SIZE)}, (_, i) => {
      const offset = i * SETTINGS_ENTRY_SIZE;
      return [body.readUInt16BE(offset), body.readUInt32BE(offset + 2)];
    }),
  );
}

/**
 * Strip HTTP/2 DATA frame padding (RFC 7540 §6.1).
 * @throws {InvalidDataError} when padding length is invalid
 */
function stripDataFramePadding(body: Buffer, flags: number): Buffer {
  if (!(flags & FLAG_PADDED)) {
    return body;
  }

  if (body.length === 0) {
    throw new InvalidDataError('PROTOCOL_ERROR: PADDED DATA frame has empty payload');
  }

  const padLength = body.readUInt8(0);
  if (padLength >= body.length) {
    throw new InvalidDataError('PROTOCOL_ERROR: Padding exceeds frame size');
  }

  return body.subarray(1, body.length - padLength);
}
