import net from 'node:net';

import { createPlist } from '../../../lib/plist/plist-creator.js';
import { parsePlist } from '../../../lib/plist/unified-plist-parser.js';
import type { PlistDictionary } from '../../../lib/types.js';
import {
  AFCMAGIC,
  AFC_HEADER_SIZE,
  AFC_OPERATION_TIMEOUT_MS,
  MAXIMUM_READ_SIZE,
  NULL_BYTE,
} from './constants.js';
import { AfcError, type AfcFopenMode, AfcOpcode } from './enums.js';
import { AfcConnectionError } from './errors.js';

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

/**
 * Encode a 64-bit unsigned integer as little-endian bytes.
 */
export function writeUInt64LE(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/**
 * Read a 64-bit unsigned little-endian integer from a buffer.
 */
export function readUInt64LE(buf: Buffer, offset = 0): bigint {
  return buf.readBigUInt64LE(offset);
}

/**
 * Convert a UTF-8 string to a null-terminated AFC C-string buffer.
 */
export function cstr(str: string): Buffer {
  const s = Buffer.from(str, 'utf8');
  return Buffer.concat([s, NULL_BYTE]);
}
/**
 * Build an AFC packet header with explicit entire_length and this_length values.
 */
export function encodeHeaderExplicit(
  op: AfcOpcode,
  packetNum: bigint,
  entireLen: number,
  thisLen: number,
): Buffer {
  const header = Buffer.alloc(AFC_HEADER_SIZE);
  AFCMAGIC.copy(header, 0);
  writeUInt64LE(BigInt(entireLen)).copy(header, 8);
  writeUInt64LE(BigInt(thisLen)).copy(header, 16);
  writeUInt64LE(packetNum).copy(header, 24);
  writeUInt64LE(BigInt(op)).copy(header, 32);
  return header;
}

/**
 * Build an AFC packet header for a single contiguous payload after the header.
 */
export function encodeHeader(
  op: AfcOpcode,
  packetNum: bigint,
  payloadLen: number,
): Buffer {
  const entireLen = AFC_HEADER_SIZE + payloadLen;
  return encodeHeaderExplicit(op, packetNum, entireLen, entireLen);
}

const SOCKET_STATES = new WeakMap<net.Socket, SocketState>();
const FATAL_SOCKETS = new WeakSet<net.Socket>();

/**
 * Tear down buffered-reader state and destroy the socket after a fatal read error.
 * Late-arriving bytes must not be left for a subsequent readExact on the same socket.
 */
export function fatalizeAfcSocket(socket: net.Socket, error: Error): void {
  FATAL_SOCKETS.add(socket);
  cleanupSocketState(socket, error);
  if (!socket.destroyed) {
    socket.destroy();
  }
}

/**
 * Read exactly `n` bytes from a socket, waiting up to timeoutMs.
 * On timeout the socket is destroyed; further reads throw AfcConnectionError.
 */
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
        const err = new AfcConnectionError(
          `readExact timeout after ${timeoutMs}ms`,
        );
        fatalizeAfcSocket(socket, err);
        reject(err);
      }
    }, timeoutMs);
  });
}

/**
 * Read and decode an AFC response header from the socket.
 */
export async function readAfcHeader(
  socket: net.Socket,
  timeoutMs = AFC_OPERATION_TIMEOUT_MS,
): Promise<AfcHeader> {
  const buf = await readExact(socket, AFC_HEADER_SIZE, timeoutMs);
  const magic = buf.subarray(0, 8);
  if (!magic.equals(AFCMAGIC)) {
    const err = new AfcConnectionError(
      `Invalid AFC magic: ${magic.toString('hex')}`,
    );
    fatalizeAfcSocket(socket, err);
    throw err;
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

/**
 * Read and decode a full AFC response (header plus payload).
 */
export async function readAfcResponse(
  socket: net.Socket,
  timeoutMs = AFC_OPERATION_TIMEOUT_MS,
): Promise<AfcResponse> {
  const header = await readAfcHeader(socket, timeoutMs);
  const payloadLen = Number(header.entireLength - BigInt(AFC_HEADER_SIZE));
  const payload =
    payloadLen > 0
      ? await readExact(socket, payloadLen, timeoutMs)
      : Buffer.alloc(0);
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

/**
 * Write a buffer to the socket, waiting for drain only when the kernel buffer is full.
 */
export async function writeBufferToSocket(
  socket: net.Socket,
  data: Buffer,
): Promise<void> {
  assertSocketReadable(socket);
  if (!data.length) {
    return;
  }
  if (socket.write(data)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClosed = () => {
      cleanup();
      reject(
        new AfcConnectionError('AFC socket closed while waiting for drain'),
      );
    };
    const cleanup = () => {
      socket.off('drain', onDrain);
      socket.off('error', onError);
      socket.off('close', onClosed);
      socket.off('end', onClosed);
    };
    socket.once('drain', onDrain);
    socket.once('error', onError);
    socket.once('close', onClosed);
    socket.once('end', onClosed);
  });
}

/**
 * Send an AFC packet as three socket writes: header, optional header payload, optional body.
 * For FILE_WRITE, headerPayload is the 8-byte handle and content is file bytes (no memcpy).
 */
export async function sendAfcPacket(
  socket: net.Socket,
  op: AfcOpcode,
  packetNum: bigint,
  headerPayload: Buffer = Buffer.alloc(0),
  content: Buffer = Buffer.alloc(0),
): Promise<void> {
  const thisLen = AFC_HEADER_SIZE + headerPayload.length;
  const entireLen = thisLen + content.length;
  const header = encodeHeaderExplicit(op, packetNum, entireLen, thisLen);
  await writeBufferToSocket(socket, header);
  await writeBufferToSocket(socket, headerPayload);
  await writeBufferToSocket(socket, content);
}

/**
 * Split a null-terminated UTF-8 buffer into string entries.
 */
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

/**
 * Parse alternating key/value C-string entries into an object map.
 */
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

/**
 * Build AFC payload for FOPEN operation.
 */
export function buildFopenPayload(mode: AfcFopenMode, path: string): Buffer {
  return Buffer.concat([writeUInt64LE(mode), cstr(path)]);
}

/**
 * Build AFC payload for READ operation.
 */
export function buildReadPayload(
  handle: bigint | number,
  size: bigint | number,
): Buffer {
  return Buffer.concat([writeUInt64LE(handle), writeUInt64LE(BigInt(size))]);
}

/**
 * Build AFC payload for CLOSE operation.
 */
export function buildClosePayload(handle: bigint | number): Buffer {
  return writeUInt64LE(handle);
}

/**
 * Build AFC payload for REMOVE_PATH operation.
 */
export function buildRemovePayload(path: string): Buffer {
  return cstr(path);
}

/**
 * Build AFC payload for MAKE_DIR operation.
 */
export function buildMkdirPayload(path: string): Buffer {
  return cstr(path);
}

/**
 * Build AFC payload for STAT operation.
 */
export function buildStatPayload(path: string): Buffer {
  return cstr(path);
}

/**
 * Build AFC payload for RENAME_PATH operation.
 */
export function buildRenamePayload(src: string, dst: string): Buffer {
  return Buffer.concat([cstr(src), cstr(dst)]);
}

/**
 * Build AFC payload for LINK_PATH operation.
 */
export function buildLinkPayload(
  type: number,
  target: string,
  source: string,
): Buffer {
  return Buffer.concat([writeUInt64LE(type), cstr(target), cstr(source)]);
}

/**
 * Send a single length-prefixed XML plist on the socket.
 */
export async function sendOnePlist(
  socket: net.Socket,
  request: PlistDictionary,
): Promise<void> {
  const xml = createPlist(request);
  const body = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  await writeBufferToSocket(socket, Buffer.concat([header, body]));
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

/**
 * Perform RSD check-in handshake for raw service sockets.
 */
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

/**
 * Create a raw socket connection to an RSD service.
 * Optionally performs RSD handshake if performHandshake is true.
 * @param host - Hostname to connect to
 * @param port - Port number
 * @param options - Connection options
 * @returns Connected socket (with handshake completed if requested)
 */
export async function createRawServiceSocket(
  host: string,
  port: number,
  options: { timeoutMs?: number; performHandshake?: boolean } = {},
): Promise<net.Socket> {
  const { timeoutMs = 10000, performHandshake = true } = options;

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection({ host, port }, () => {
      conn.setKeepAlive(true);
      conn.setNoDelay(true);
      resolve(conn);
    });
    conn.setTimeout(timeoutMs, () => {
      conn.destroy();
      reject(new Error('Connection timed out'));
    });
    conn.on('error', reject);
  });

  if (performHandshake) {
    await rsdHandshakeForRawService(socket);
  }

  // Connect-time idle timeout must not apply to long-lived service I/O.
  socket.setTimeout(0);

  return socket;
}

/**
 * Compute next AFC read chunk size from bytes remaining.
 */
export function nextReadChunkSize(left: bigint | number): number {
  const leftNum = typeof left === 'bigint' ? Number(left) : left;
  return Math.min(leftNum, MAXIMUM_READ_SIZE);
}

/**
 * Convert nanoseconds to milliseconds for Date construction
 * @param nanoseconds - Time value in nanoseconds as a string
 * @returns Time value in milliseconds
 */
export function nanosecondsToMilliseconds(nanoseconds: string): number {
  return Number(BigInt(nanoseconds) / 1000000n);
}

/**
 * Remove socket listeners and reject pending read waiters.
 */
export function cleanupServiceSocket(socket: net.Socket, error?: Error): void {
  cleanupSocketState(socket, error);
}

function assertSocketReadable(socket: net.Socket): void {
  if (FATAL_SOCKETS.has(socket)) {
    throw new AfcConnectionError(
      'AFC connection is closed (prior read timeout or fatal I/O error)',
    );
  }
  if (socket.destroyed) {
    throw new AfcConnectionError('AFC socket is destroyed');
  }
}

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
    const w = state.waiters.shift();
    if (!w) {
      continue;
    }
    if (w.timer) {
      clearTimeout(w.timer);
    }
    w.reject(err);
  }

  // Remove from WeakMap
  SOCKET_STATES.delete(socket);
}

/**
 * Ensure per-socket buffered reader state and listeners are initialized.
 */
function ensureSocketState(socket: net.Socket): SocketState {
  assertSocketReadable(socket);
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
        const w = st.waiters.shift();
        if (!w) {
          continue;
        }
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
