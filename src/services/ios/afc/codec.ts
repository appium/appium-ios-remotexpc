import net from 'node:net';

import { createPlist } from '../../../lib/plist/plist-creator.js';
import { parsePlist } from '../../../lib/plist/unified-plist-parser.js';
import { AFCMAGIC, AFC_HEADER_SIZE, NULL_BYTE } from './constants.js';
import { AfcError, AfcFopenMode, AfcOpcode } from './enums.js';

export interface AfcHeader {
  magic: Buffer;
  entireLength: bigint;
  thisLength: bigint;
  packetNum: bigint;
  operation: bigint;
}

export interface AfcResponse {
  status: AfcError;
  data: Buffer;
  operation: AfcOpcode;
  rawHeader: AfcHeader;
}

export function writeUInt64LE(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

export function readUInt64LE(buf: Buffer, offset = 0): bigint {
  return buf.readBigUInt64LE(offset);
}

export function cstr(str: string): Buffer {
  const s = Buffer.from(str, 'utf8');
  return Buffer.concat([s, NULL_BYTE]);
}

export function encodeHeader(
  op: AfcOpcode,
  packetNum: bigint,
  payloadLen: number,
  thisLenOverride?: number,
): Buffer {
  const entireLen = BigInt(AFC_HEADER_SIZE + payloadLen);
  const thisLen = BigInt(thisLenOverride ?? AFC_HEADER_SIZE + payloadLen);

  const header = Buffer.alloc(AFC_HEADER_SIZE);
  // magic
  AFCMAGIC.copy(header, 0);
  // entire_length
  writeUInt64LE(entireLen).copy(header, 8);
  // this_length
  writeUInt64LE(thisLen).copy(header, 16);
  // packet_num
  writeUInt64LE(packetNum).copy(header, 24);
  // operation
  writeUInt64LE(BigInt(op)).copy(header, 32);

  return header;
}

/**
 * Internal per-socket buffered reader to avoid re-emitting data and race conditions.
 */
type SocketWaiter = {
  n: number;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};
type SocketState = {
  buffer: Buffer;
  waiters: SocketWaiter[];
  onData: (chunk: Buffer) => void;
  onError: (err: Error) => void;
  onClose: () => void;
};

const SOCKET_STATES = new WeakMap<net.Socket, SocketState>();

function cleanupSocketState(socket: net.Socket, error?: Error): void {
  const state = SOCKET_STATES.get(socket);
  if (!state) {
    return;
  }

  // Remove all event listeners to prevent memory leaks
  socket.removeListener('data', state.onData);
  socket.removeListener('error', state.onError);
  socket.removeListener('close', state.onClose);
  socket.removeListener('end', state.onClose);

  // Reject any pending waiters
  const err = error || new Error('Socket closed');
  while (state.waiters.length) {
    const w = state.waiters.shift()!;
    if (w.timer) {
      clearTimeout(w.timer);
    }
    w.reject(err);
  }

  // Remove from WeakMap
  SOCKET_STATES.delete(socket);
}

function ensureSocketState(socket: net.Socket): SocketState {
  let state = SOCKET_STATES.get(socket);
  if (state) {
    return state;
  }

  state = {
    buffer: Buffer.alloc(0),
    waiters: [],
    onData: (chunk: Buffer) => {
      const st = SOCKET_STATES.get(socket);
      if (!st) {
        return;
      }
      st.buffer = Buffer.concat([st.buffer, chunk]);

      while (st.waiters.length && st.buffer.length >= st.waiters[0].n) {
        const w = st.waiters.shift()!;
        const out = st.buffer.subarray(0, w.n);
        st.buffer = st.buffer.subarray(w.n);
        if (w.timer) {
          clearTimeout(w.timer);
        }
        w.resolve(out);
      }
    },
    onError: (err: Error) => {
      cleanupSocketState(socket, err);
    },
    onClose: () => {
      cleanupSocketState(socket);
    },
  };

  socket.on('data', state.onData);
  socket.once('error', state.onError);
  socket.once('close', state.onClose);
  socket.once('end', state.onClose);
  SOCKET_STATES.set(socket, state);
  return state;
}

export async function readExact(
  socket: net.Socket,
  n: number,
  timeoutMs = 30000,
): Promise<Buffer> {
  const state = ensureSocketState(socket);

  if (state.buffer.length >= n) {
    const out = state.buffer.subarray(0, n);
    state.buffer = state.buffer.subarray(n);
    return out;
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const waiter: SocketWaiter = { n, resolve, reject };
    state.waiters.push(waiter);
    waiter.timer = setTimeout(() => {
      const idx = state.waiters.indexOf(waiter);
      if (idx >= 0) {
        state.waiters.splice(idx, 1);
        reject(new Error(`readExact timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

export async function readAfcHeader(socket: net.Socket): Promise<AfcHeader> {
  const buf = await readExact(socket, AFC_HEADER_SIZE);
  const magic = buf.subarray(0, 8);
  if (!magic.equals(AFCMAGIC)) {
    throw new Error(`Invalid AFC magic: ${magic.toString('hex')}`);
  }
  const entireLength = readUInt64LE(buf, 8);
  const thisLength = readUInt64LE(buf, 16);
  const packetNum = readUInt64LE(buf, 24);
  const operation = readUInt64LE(buf, 32);
  return {
    magic,
    entireLength,
    thisLength,
    packetNum,
    operation,
  };
}

export async function readAfcResponse(
  socket: net.Socket,
): Promise<AfcResponse> {
  const header = await readAfcHeader(socket);
  const payloadLen = Number(header.entireLength - BigInt(AFC_HEADER_SIZE));
  const payload =
    payloadLen > 0 ? await readExact(socket, payloadLen) : Buffer.alloc(0);
  const op = Number(header.operation) as AfcOpcode;

  if (op === AfcOpcode.STATUS) {
    const status = Number(readUInt64LE(payload.subarray(0, 8))) as AfcError;
    return { status, data: Buffer.alloc(0), operation: op, rawHeader: header };
  }

  return {
    status: AfcError.SUCCESS,
    data: payload,
    operation: op,
    rawHeader: header,
  };
}

export async function sendAfcPacket(
  socket: net.Socket,
  op: AfcOpcode,
  packetNum: bigint,
  payload: Buffer = Buffer.alloc(0),
  thisLenOverride?: number,
): Promise<void> {
  const header = encodeHeader(op, packetNum, payload.length, thisLenOverride);
  await new Promise<void>((resolve, reject) => {
    socket.write(header, (err) => {
      if (err) {
        return reject(err);
      }
      if (payload.length) {
        socket.write(payload, (err2) => {
          if (err2) {
            return reject(err2);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

export function parseCStringArray(buf: Buffer): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) {
      const slice = buf.subarray(start, i);
      parts.push(slice.toString('utf8'));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    parts.push(buf.subarray(start).toString('utf8'));
  }
  while (parts.length && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

export function parseKeyValueNullList(buf: Buffer): Record<string, string> {
  const arr = parseCStringArray(buf);
  if (arr.length % 2 !== 0) {
    throw new Error('Invalid key/value AFC list (odd number of entries)');
  }
  return Object.fromEntries(
    Array.from({ length: arr.length / 2 }, (_, i) => [
      arr[i * 2],
      arr[i * 2 + 1],
    ]),
  );
}

export function buildFopenPayload(mode: AfcFopenMode, path: string): Buffer {
  return Buffer.concat([writeUInt64LE(mode), cstr(path)]);
}

export function buildReadPayload(
  handle: bigint | number,
  size: bigint | number,
): Buffer {
  return Buffer.concat([writeUInt64LE(handle), writeUInt64LE(BigInt(size))]);
}

export function buildClosePayload(handle: bigint | number): Buffer {
  return writeUInt64LE(handle);
}

export function buildRemovePayload(path: string): Buffer {
  return cstr(path);
}

export function buildMkdirPayload(path: string): Buffer {
  return cstr(path);
}

export function buildStatPayload(path: string): Buffer {
  return cstr(path);
}

export function buildRenamePayload(src: string, dst: string): Buffer {
  return Buffer.concat([cstr(src), cstr(dst)]);
}

export function buildLinkPayload(
  type: number,
  target: string,
  source: string,
): Buffer {
  return Buffer.concat([writeUInt64LE(type), cstr(target), cstr(source)]);
}

/**
 * Receive a single length-prefixed plist from the socket
 */
export async function recvOnePlist(socket: net.Socket): Promise<any> {
  const lenBuf = await readExact(socket, 4);
  const respLen = lenBuf.readUInt32BE(0);
  const respBody = await readExact(socket, respLen);
  return parsePlist(respBody);
}

export async function rsdHandshakeForRawService(
  socket: net.Socket,
): Promise<void> {
  const request = {
    Label: 'appium-internal',
    ProtocolVersion: '2',
    Request: 'RSDCheckin',
  };
  const xml = createPlist(request);
  const body = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  await new Promise<void>((resolve, reject) => {
    socket.write(Buffer.concat([header, body]), (err) =>
      err ? reject(err) : resolve(),
    );
  });

  const first = await recvOnePlist(socket);
  if (!first || first.Request !== 'RSDCheckin') {
    throw new Error(`Invalid RSDCheckin response: ${JSON.stringify(first)}`);
  }

  const second = await recvOnePlist(socket);
  if (!second || second.Request !== 'StartService') {
    throw new Error(`Invalid StartService response: ${JSON.stringify(second)}`);
  }
}

export function nextReadChunkSize(left: bigint | number): number {
  const leftNum = typeof left === 'bigint' ? Number(left) : left;
  return leftNum;
}

/**
 * Convert nanoseconds to milliseconds for Date construction
 * @param nanoseconds - Time value in nanoseconds as a string
 * @returns Time value in milliseconds
 */
export function nanosecondsToMilliseconds(nanoseconds: string): number {
  return Number(BigInt(nanoseconds) / 1000000n);
}
