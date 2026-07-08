import {getLogger} from '../../../../lib/logger.js';
import {MessageAux} from '../dtx-message.js';
import {type DVTSecureSocketProxyService} from '../index.js';
import {BaseInstrument} from './base-instrument.js';

const log = getLogger('ActivityTraceTap');

const CMD_DEFINE_TABLE = 0x01;
const CMD_END_ROW = 0x02;
const CMD_CONVERT_MACH_CONTINUOUS = 0x05;
const CMD_TABLE_RESET = 0x64;
const CMD_COPY = 0x65;
const CMD_SENTINEL = 0x68;
const CMD_STRUCT = 0x69;
const CMD_PLACEHOLDER_COUNT = 0x6a;
const CMD_DEBUG = 0x6b;

const BPLIST_MAGIC = Buffer.from('bplist');

const STRING_FIELDS = new Set([
  'message_type',
  'format_string',
  'subsystem',
  'category',
  'sender_image_path',
  'process_image_path',
  'event_type',
  'name',
  'signpost_name',
  'scope',
]);

/** A single decoded log/signpost row from the activity trace stream. */
export type ActivityTraceMessage = Record<string, unknown>;

export interface ActivityTraceTapOptions {
  /** When true, request the device to include HTTP archive (HAR) logging. */
  enableHttpArchiveLogging?: boolean;
}

type StackItem = Buffer | null | StackItem[];

interface Table {
  name: string;
  columns: string[];
}

/**
 * Tap the device's unified-logging / activity-trace stream over the Instruments
 * channel (`com.apple.instruments.server.services.activitytracetap`).
 *
 * The wire format is a stack-based opcode stream. Opcodes may be split across
 * DTX frames; the parser carries unfinished bytes to the next frame. Iterating
 * {@link messages} yields one decoded record per completed row (os-log,
 * os-log-arg, os-signpost, and os-signpost-arg rows are all emitted).
 *
 * @example
 * ```typescript
 * const { activityTraceTap, dvtService } = await Services.startDVTService(udid);
 * try {
 *   for await (const entry of activityTraceTap.messages()) {
 *     console.log(entry.time, entry.process, entry.message);
 *   }
 * } finally {
 *   await activityTraceTap.stop();
 *   await dvtService.close();
 * }
 * ```
 */
export class ActivityTraceTap extends BaseInstrument {
  static readonly IDENTIFIER = 'com.apple.instruments.server.services.activitytracetap';

  private stack: StackItem[] = [];
  private tables: Map<number, Table> = new Map();
  private carry = Buffer.alloc(0);
  private started = false;
  private stopRequested = false;
  private receiveAbortController: AbortController | null = null;

  constructor(
    dvt: DVTSecureSocketProxyService,
    private readonly options: ActivityTraceTapOptions = {},
  ) {
    super(dvt);
  }

  async start(): Promise<void> {
    if (this.started) {
      log.debug('ActivityTraceTap already started; start() is a no-op');
      return;
    }
    await this.initialize();
    const config = {
      bm: 0,
      combineDataScope: 0,
      machTimebaseDenom: 3,
      machTimebaseNumer: 125,
      onlySignposts: 0,
      pidToInjectCombineDYLIB: '-1',
      predicate:
        '(messageType == info OR messageType == debug OR messageType == default OR ' +
        'messageType == error OR messageType == fault)',
      signpostsAndLogs: 1,
      trackPidToExecNameMapping: true,
      enableHTTPArchiveLogging: this.options.enableHttpArchiveLogging ?? false,
      targetPID: -3,
      trackExpiredPIDs: 1,
      ur: 500,
    };
    const channel = this.requireChannel();
    await channel.call('setConfig_')(new MessageAux().appendObj(config), true);
    await channel.receivePlist(); // consume setConfig_ ack
    await channel.call('start')(undefined, true);
    await channel.receivePlist(); // consume start ack
    this.started = true;
    this.stopRequested = false;
    log.debug('ActivityTraceTap started');
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.receiveAbortController?.abort();
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.channel) {
      try {
        await this.requireChannel().call('stop')(undefined, false);
      } catch (err) {
        log.debug('stop() failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Async generator that yields decoded log entries as they arrive.
   * Starts the tap if not already started; stops when the generator is
   * returned or {@link stop} is called.
   */
  async *messages(): AsyncGenerator<ActivityTraceMessage, void, unknown> {
    await this.start();
    // Anchors mach continuous time (ns) to wall clock on the first message.
    let bootEpochMs: number | null = null;
    try {
      while (!this.stopRequested) {
        const ac = new AbortController();
        this.receiveAbortController = ac;

        let raw: Buffer | null;
        try {
          [raw] = await this.dvt.recvMessage(this.requireChannel().getCode(), ac.signal);
        } catch (err) {
          if (this.stopRequested || this.isAbortError(err)) {
            break;
          }
          log.debug('read error:', err instanceof Error ? err.message : err);
          break;
        } finally {
          if (this.receiveAbortController === ac) {
            this.receiveAbortController = null;
          }
        }

        if (!raw) {
          continue;
        }

        // Heartbeat / control frames are bplist-encoded – skip them.
        if (raw.length >= BPLIST_MAGIC.length && raw.subarray(0, BPLIST_MAGIC.length).equals(BPLIST_MAGIC)) {
          log.debug('skipping bplist frame');
          continue;
        }

        // Prepend any bytes carried over from a truncated previous frame.
        const frame = this.carry.length > 0 ? Buffer.concat([this.carry, raw]) : raw;
        this.carry = Buffer.alloc(0);

        for (const msg of this.parseFrame(frame)) {
          if (typeof msg.time === 'number') {
            if (bootEpochMs === null) {
              bootEpochMs = Date.now() - msg.time / 1e6;
            }
            msg.time = new Date(bootEpochMs + msg.time / 1e6).toISOString();
          }
          yield msg;
        }
      }
    } finally {
      await this.stop();
    }
  }

  private *parseFrame(frame: Buffer): Generator<ActivityTraceMessage> {
    const cur = {pos: 0};

    const readWord = (): number => {
      if (cur.pos + 2 > frame.length) {
        throw new RangeError('eof');
      }
      const w = frame.readUInt16LE(cur.pos);
      cur.pos += 2;
      return w;
    };

    while (cur.pos < frame.length) {
      const start = cur.pos;
      try {
        const word = readWord();
        const opcode = word >> 8;
        let result: ActivityTraceMessage | null = null;

        switch (opcode) {
          case CMD_TABLE_RESET:
            this.stack = [];
            break;
          case CMD_SENTINEL:
            this.stack.push(null);
            break;
          case CMD_STRUCT:
            this.handleStruct(word);
            break;
          case CMD_DEFINE_TABLE:
            this.parseDefineTable(word & 0xff);
            break;
          case CMD_DEBUG:
            this.stack.pop();
            break;
          case CMD_COPY:
            this.handleCopy(word);
            break;
          case CMD_PLACEHOLDER_COUNT:
            this.handlePlaceholderCount(word);
            break;
          case CMD_CONVERT_MACH_CONTINUOUS:
            break;
          case CMD_END_ROW:
            result = this.parseEndRow(word);
            break;
          default:
            // Push opcode: the first word is the one we just read.
            this.handlePush(word, readWord);
            break;
        }

        if (result !== null) {
          yield result;
        }
      } catch (err) {
        if (err instanceof RangeError) {
          // Frame ended mid-opcode; carry the remaining bytes forward.
          this.carry = Buffer.from(frame.subarray(start));
          return;
        }
        throw err;
      }
    }
  }

  private handlePush(firstWord: number, readWord: () => number): void {
    let word = firstWord;
    let imm = 0n;
    let bitCount = 0;

    while (word >> 14 !== 0b11) {
      imm = (imm << 14n) | BigInt(word & 0x3fff);
      word = readWord();
      bitCount += 14;
    }

    imm = (imm << 14n) | BigInt(word & 0x3fff);
    bitCount += 14;

    // Always pads to the next byte boundary, adding a full byte if already aligned.
    const pad = 8 - (bitCount % 8);
    imm <<= BigInt(pad);
    bitCount += pad;

    const byteCount = Math.ceil(bitCount / 8);
    const result = Buffer.alloc(byteCount);
    let tmp = imm;
    for (let i = byteCount - 1; i >= 0; i--) {
      result[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }

    this.stack.push(result);
  }

  private handleStruct(word: number): void {
    const distance = word & 0xff;
    if (distance === 0xff) {
      // Long struct: pop count from stack
      const countItem = this.stack.pop();
      const count = Buffer.isBuffer(countItem) ? readLEIntFromBuffer(countItem) : 0;
      this.stack.push(this.stack.splice(this.stack.length - count, count));
    } else {
      this.stack.push(this.stack.splice(this.stack.length - distance, distance));
    }
  }

  private handleCopy(word: number): void {
    const distance = word & 0xff;
    if (distance !== 0xff) {
      this.stack.push(this.stack[this.stack.length - distance - 1] ?? null);
    } else {
      // Long copy: pop a buffer, interpret as little-endian index.
      const item = this.stack.pop();
      if (Buffer.isBuffer(item)) {
        const ref = readLEIntFromBuffer(item) - 1;
        this.stack.push(this.stack[ref] ?? null);
      }
    }
  }

  private handlePlaceholderCount(word: number): void {
    const count = word & 0xff;
    if (count > 0) {
      this.stack.splice(this.stack.length - count, count);
    }
  }

  private parseDefineTable(tableId: number): void {
    if (this.stack.length < 4) {
      return;
    }
    const items = this.stack.splice(this.stack.length - 4, 4);
    const nameRaw = items[2];
    const columnsRaw = items[3];

    const name = Buffer.isBuffer(nameRaw) ? decodeStr(nameRaw) : '';
    const columns: string[] = [];
    if (Array.isArray(columnsRaw)) {
      for (const item of columnsRaw as StackItem[]) {
        if (Buffer.isBuffer(item)) {
          columns.push(decodeStr(item as Buffer));
        } else {
          columns.push('');
        }
      }
    }
    this.tables.set(tableId, {name, columns});
  }

  private parseEndRow(word: number): ActivityTraceMessage | null {
    const tableIndex = word & 0xff;
    const tableEntry = this.tables.get(tableIndex);
    if (!tableEntry) {
      return null;
    }

    const {columns} = tableEntry;
    if (this.stack.length < columns.length) {
      return null;
    }

    const row = this.stack.splice(this.stack.length - columns.length, columns.length);

    const msg: ActivityTraceMessage = {};
    for (let i = 0; i < columns.length; i++) {
      msg[columns[i].replace(/-/g, '_')] = row[i];
    }

    // time: nanoseconds since boot (mach continuous time)
    if ('time' in msg && Buffer.isBuffer(msg.time)) {
      msg.time = readLEIntFromBuffer(msg.time as Buffer);
    }

    // process: None → 0, struct → uint32LE from first element
    if ('process' in msg) {
      msg.process = msg.process === null ? 0 : readUInt32LEFromStruct(msg.process as StackItem);
    }

    // thread: struct → uint32LE from first element
    if ('thread' in msg) {
      msg.thread = readUInt32LEFromStruct(msg.thread as StackItem);
    }

    // identifier: signpost id — an opaque little-endian value. Render as a
    // lossless lowercase hex string (it routinely exceeds Number precision).
    if ('identifier' in msg && Buffer.isBuffer(msg.identifier)) {
      msg.identifier = decodeHex(msg.identifier as Buffer);
    }

    for (const field of STRING_FIELDS) {
      if (field in msg && Buffer.isBuffer(msg[field])) {
        msg[field] = decodeStr(msg[field] as Buffer);
      }
    }

    // 'value' column in os-log-arg rows carries (type, data) pairs — same format as message.
    if ('value' in msg && Array.isArray(msg.value)) {
      msg.value = decodeMessageFormat(msg.value as StackItem[]);
    }

    if ('message' in msg && Array.isArray(msg.message)) {
      msg.message = decodeMessageFormat(msg.message as StackItem[]);
    }

    // A literal `message` column may be present but null — signpost begin/end
    // rows carry their text in `name` and leave `message`/`format_string` null.
    // Fall through on any value that has not resolved to a string rather than
    // on key presence, otherwise those rows leak `message: null`.
    if (typeof msg.message !== 'string' && Array.isArray(msg.format_string)) {
      msg.message = decodeMessageFormat(msg.format_string as StackItem[]);
    }

    // Signpost entries use a "name" column as their message text.
    if (typeof msg.message !== 'string' && typeof msg.name === 'string') {
      msg.message = msg.name;
    }

    // Still unresolved — synthesize a message from the longest Buffer in the
    // row, but only for rich tables (≥5 columns) so trivial housekeeping rows
    // are silently dropped.
    if (typeof msg.message !== 'string') {
      if (columns.length < 5) {
        return null;
      }
      let best: Buffer | null = null;
      for (const v of row) {
        if (Buffer.isBuffer(v) && (best === null || (v as Buffer).length > best.length)) {
          best = v as Buffer;
        }
      }
      msg.message = best !== null ? decodeStr(best) : '';
    }
    if (!('process' in msg)) {
      msg.process = 0;
    }
    if (!('thread' in msg)) {
      msg.thread = 0;
    }

    return msg;
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof DOMException || (err instanceof Error && err.name === 'AbortError');
  }
}

function decodeStr(buf: Buffer): string {
  const nullIdx = buf.indexOf(0);
  return (nullIdx >= 0 ? buf.subarray(0, nullIdx) : buf).toString('utf8');
}

function decodeHex(buf: Buffer): string {
  // Push opcodes pad to a byte boundary, so drop a trailing sentinel null byte.
  const trimmed = buf.length > 0 && buf[buf.length - 1] === 0 ? buf.subarray(0, buf.length - 1) : buf;
  return trimmed.toString('hex');
}

function decodeMessageFormat(message: StackItem[]): string {
  const parts: string[] = [];
  for (const pair of message) {
    if (!Array.isArray(pair)) {
      continue;
    }
    const pairArr = pair as StackItem[];
    const typeRaw = pairArr[0];
    const dataRaw = pairArr.length > 1 ? pairArr[1] : null;
    if (!Buffer.isBuffer(typeRaw)) {
      continue;
    }

    let typeName = decodeStr(typeRaw as Buffer);
    if (typeName === 'address') {
      typeName = 'uint64-hex';
    }

    const data = Buffer.isBuffer(dataRaw) ? (dataRaw as Buffer) : null;

    if (typeName === 'narrative-text' || typeName === 'string') {
      parts.push(data !== null ? decodeStr(data) : '<None>');
    } else if (typeName === 'private') {
      parts.push('<private>');
    } else if (typeName.startsWith('uint64') || typeName.includes('decimal')) {
      const padded = Buffer.concat([data ?? Buffer.alloc(0), Buffer.alloc(8)]).subarray(0, 8);
      const val = padded.readBigUInt64LE(0);
      if (typeName.includes('hex')) {
        const hex = val.toString(16);
        parts.push(typeName.includes('lowercase') ? hex : hex.toUpperCase());
      } else {
        parts.push(val.toString());
      }
    } else if (typeName === 'data' || typeName === 'uuid') {
      parts.push(data !== null ? data.toString('hex') : '');
    } else {
      parts.push(data !== null ? decodeStr(data) : '');
    }
  }
  return parts.join('');
}

function readUInt32LEFromStruct(item: StackItem): number {
  if (!Array.isArray(item) || !Buffer.isBuffer(item[0])) {
    return 0;
  }
  const src = item[0] as Buffer;
  const buf = src.length < 4 ? Buffer.concat([src, Buffer.alloc(4 - src.length)]) : src;
  return buf.readUInt32LE(0);
}

function readLEIntFromBuffer(buf: Buffer): number {
  const padded = buf.length < 8 ? Buffer.concat([buf, Buffer.alloc(8 - buf.length)]) : buf;
  return Number(padded.readBigUInt64LE(0));
}
