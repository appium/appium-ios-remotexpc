import path from 'path';

import { getLogger } from '../../../lib/logger.js';

const log = getLogger('SyslogParser');

/** Log level constants from the os_trace_relay binary protocol */
export enum SyslogLogLevel {
  Notice = 0x00,
  Info = 0x01,
  Debug = 0x02,
  UserAction = 0x03,
  Error = 0x10,
  Fault = 0x11,
}

const SYSLOG_LOG_LEVEL_NAMES: Record<number, string> = {
  [SyslogLogLevel.Notice]: 'NOTICE',
  [SyslogLogLevel.Info]: 'INFO',
  [SyslogLogLevel.Debug]: 'DEBUG',
  [SyslogLogLevel.UserAction]: 'USER_ACTION',
  [SyslogLogLevel.Error]: 'ERROR',
  [SyslogLogLevel.Fault]: 'FAULT',
};

export interface SyslogLabel {
  subsystem: string;
  category: string;
}

export interface SyslogEntry {
  pid: number;
  timestamp: Date;
  /** Raw seconds component of the timestamp (for microsecond formatting) */
  timestampSeconds: number;
  /** Raw microseconds component of the timestamp */
  timestampMicroseconds: number;
  level: SyslogLogLevel;
  levelName: string;
  imageName: string;
  imageOffset: number;
  filename: string;
  message: string;
  label?: SyslogLabel;
}

/** Marker byte that precedes each syslog entry in the protocol */
const ENTRY_MARKER = 0x02;

/**
 * Minimum syslog entry data size.
 * The fixed-size header is 129 bytes + at least a null terminator for filename.
 */
const MIN_ENTRY_SIZE = 50;

/** Maximum reasonable syslog entry size (64 KB) */
const MAX_ENTRY_SIZE = 65536;

/** Maximum buffer size before forced reset (10 MB) */
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/*
 * Binary layout offsets for a syslog entry (os_trace_relay protocol):
 *
 * Offset  Size  Field
 * 0       9     Header (skip)
 * 9       4     PID (uint32 LE)
 * 13      42    Skip
 * 55      4     Timestamp seconds (uint32 LE)
 * 59      4     Skip
 * 63      4     Timestamp microseconds (uint32 LE)
 * 67      1     Skip
 * 68      1     Log level
 * 69      38    Skip
 * 107     2     Image name size (uint16 LE)
 * 109     2     Message size (uint16 LE)
 * 111     2     Skip
 * 113     4     Sender image offset (uint32 LE)
 * 117     4     Subsystem size (uint32 LE)
 * 121     4     Category size (uint32 LE)
 * 125     4     Skip
 * 129     var   Filename (null-terminated)
 * var     var   Image name (image_name_size bytes)
 * var     var   Message (message_size bytes)
 * var     var   Subsystem (subsystem_size bytes, optional)
 * var     var   Category (category_size bytes, optional)
 */
const OFFSET_PID = 9;
const OFFSET_TIMESTAMP_SECONDS = 55;
const OFFSET_TIMESTAMP_MICROSECONDS = 63;
const OFFSET_LEVEL = 68;
const OFFSET_IMAGE_NAME_SIZE = 107;
const OFFSET_MESSAGE_SIZE = 109;
const OFFSET_IMAGE_OFFSET = 113;
const OFFSET_SUBSYSTEM_SIZE = 117;
const OFFSET_CATEGORY_SIZE = 121;
const OFFSET_VARIABLE_FIELDS = 129;

/**
 * Safely decode a buffer slice to a UTF-8 string, falling back to latin1.
 */
function tryDecode(data: Buffer): string {
  try {
    return data.toString('utf8');
  } catch {
    return data.toString('latin1');
  }
}

/**
 * Get the human-readable name for a syslog log level.
 */
export function getLogLevelName(level: number): string {
  return SYSLOG_LOG_LEVEL_NAMES[level] ?? `UNKNOWN(0x${level.toString(16)})`;
}

/**
 * Parse a single syslog entry from binary data.
 * Based on the os_trace_relay binary protocol.
 */
export function parseSyslogEntry(data: Buffer): SyslogEntry {
  if (data.length < OFFSET_VARIABLE_FIELDS) {
    throw new Error(
      `Entry data too short: ${data.length} bytes (need at least ${OFFSET_VARIABLE_FIELDS})`,
    );
  }

  const pid = data.readUInt32LE(OFFSET_PID);
  const seconds = data.readUInt32LE(OFFSET_TIMESTAMP_SECONDS);
  const microseconds = data.readUInt32LE(OFFSET_TIMESTAMP_MICROSECONDS);
  const timestamp = new Date(seconds * 1000 + microseconds / 1000);
  const level = data[OFFSET_LEVEL] as SyslogLogLevel;

  const imageNameSize = data.readUInt16LE(OFFSET_IMAGE_NAME_SIZE);
  const messageSize = data.readUInt16LE(OFFSET_MESSAGE_SIZE);
  const senderImageOffset = data.readUInt32LE(OFFSET_IMAGE_OFFSET);
  const subsystemSize = data.readUInt32LE(OFFSET_SUBSYSTEM_SIZE);
  const categorySize = data.readUInt32LE(OFFSET_CATEGORY_SIZE);

  let offset = OFFSET_VARIABLE_FIELDS;

  // Parse filename (null-terminated string)
  const filenameEnd = data.indexOf(0x00, offset);
  if (filenameEnd === -1) {
    throw new Error('Could not find null terminator for filename');
  }
  const filename = tryDecode(data.subarray(offset, filenameEnd));
  offset = filenameEnd + 1;

  // Parse image_name (imageNameSize bytes, minus the null terminator)
  const imageName =
    imageNameSize > 1
      ? tryDecode(data.subarray(offset, offset + imageNameSize - 1))
      : '';
  offset += imageNameSize;

  // Parse message (messageSize bytes, minus the null terminator)
  const message =
    messageSize > 1
      ? tryDecode(data.subarray(offset, offset + messageSize - 1))
      : '';
  offset += messageSize;

  // Parse label (subsystem + category, optional)
  let label: SyslogLabel | undefined;
  if (subsystemSize > 0 && categorySize > 0) {
    const subsystem =
      subsystemSize > 1
        ? tryDecode(data.subarray(offset, offset + subsystemSize - 1))
        : '';
    offset += subsystemSize;
    const category =
      categorySize > 1
        ? tryDecode(data.subarray(offset, offset + categorySize - 1))
        : '';
    offset += categorySize;
    label = { subsystem, category };
  }

  return {
    pid,
    timestamp,
    timestampSeconds: seconds,
    timestampMicroseconds: microseconds,
    level,
    levelName: getLogLevelName(level),
    imageName,
    imageOffset: senderImageOffset,
    filename,
    message,
    label,
  };
}

/**
 * Format a timestamp with microsecond precision.
 */
function formatTimestamp(seconds: number, microseconds: number): string {
  const date = new Date(seconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const secs = String(date.getSeconds()).padStart(2, '0');
  const micro = String(microseconds).padStart(6, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${secs}.${micro}`;
}

// ANSI color codes
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const WHITE = '\x1b[37m';

const LOG_LEVEL_COLORS: Record<number, string> = {
  [SyslogLogLevel.Notice]: WHITE,
  [SyslogLogLevel.Info]: WHITE,
  [SyslogLogLevel.Debug]: GREEN,
  [SyslogLogLevel.UserAction]: WHITE,
  [SyslogLogLevel.Error]: RED,
  [SyslogLogLevel.Fault]: RED,
};

/**
 * Format a syslog entry as a plain (uncolored) string.
 *
 * Format: `TIMESTAMP PROCESS{IMAGE_NAME}[PID] <LEVEL>: MESSAGE [SUBSYSTEM][CATEGORY]`
 *
 * Matches the standard os_trace_relay output format.
 */
export function formatSyslogEntry(entry: SyslogEntry): string {
  const ts = formatTimestamp(
    entry.timestampSeconds,
    entry.timestampMicroseconds,
  );
  const processName = path.basename(entry.filename);
  const imageName = path.basename(entry.imageName);

  let line = `${ts} ${processName}{${imageName}}[${entry.pid}] <${entry.levelName}>: ${entry.message}`;

  if (entry.label) {
    line += ` [${entry.label.subsystem}][${entry.label.category}]`;
  }

  return line;
}

/**
 * Format a syslog entry as a colored string for terminal display.
 *
 * Color scheme:
 *   Timestamp    → green
 *   Process name → magenta
 *   Image name   → magenta
 *   PID          → cyan
 *   Level        → varies (green=DEBUG, white=INFO/NOTICE, red=ERROR/FAULT)
 *   Message      → same color as level
 *   Label        → cyan
 */
export function formatSyslogEntryColored(entry: SyslogEntry): string {
  const ts = formatTimestamp(
    entry.timestampSeconds,
    entry.timestampMicroseconds,
  );
  const processName = path.basename(entry.filename);
  const imageName = path.basename(entry.imageName);
  const levelColor = LOG_LEVEL_COLORS[entry.level] ?? WHITE;

  let line =
    `${GREEN}${ts}${RESET} ` +
    `${MAGENTA}${processName}${RESET}` +
    `{${MAGENTA}${imageName}${RESET}}` +
    `[${CYAN}${entry.pid}${RESET}] ` +
    `<${levelColor}${entry.levelName}${RESET}>: ` +
    `${levelColor}${entry.message}${RESET}`;

  if (entry.label) {
    line += ` ${CYAN}[${entry.label.subsystem}][${entry.label.category}]${RESET}`;
  }

  return line;
}

/**
 * Streaming parser for the os_trace_relay binary syslog protocol.
 *
 * The protocol sends syslog entries as:
 *   0x02 (marker) + 4-byte LE uint32 (length) + binary entry data
 *
 * This parser buffers incoming TCP payload data and extracts individual
 * syslog entries, handling fragmentation across TCP packets.
 */
export class SyslogProtocolParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly onEntry: (entry: SyslogEntry) => void;
  private readonly onError: (error: Error) => void;

  constructor(
    onEntry: (entry: SyslogEntry) => void,
    onError: (error: Error) => void = () => {},
  ) {
    this.onEntry = onEntry;
    this.onError = onError;
  }

  /**
   * Feed raw TCP payload data into the parser.
   */
  addData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    if (this.buffer.length > MAX_BUFFER_SIZE) {
      log.debug(`Buffer exceeded ${MAX_BUFFER_SIZE} bytes, resetting`);
      this.buffer = Buffer.alloc(0);
      return;
    }

    this.processBuffer();
  }

  /** Reset the parser state and clear the buffer. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const markerIndex = this.buffer.indexOf(ENTRY_MARKER);
      if (markerIndex === -1) {
        // No marker found — discard non-syslog data
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Discard bytes before the marker
      if (markerIndex > 0) {
        this.buffer = this.buffer.subarray(markerIndex);
      }

      // Need at least marker (1) + length (4) = 5 bytes
      if (this.buffer.length < 5) {
        break;
      }

      const entryLength = this.buffer.readUInt32LE(1);

      // Validate entry length to filter false 0x02 markers
      if (entryLength < MIN_ENTRY_SIZE || entryLength > MAX_ENTRY_SIZE) {
        // Likely a false marker — skip this byte and try again
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      // Check if the full entry is available in the buffer
      const totalSize = 1 + 4 + entryLength;
      if (this.buffer.length < totalSize) {
        break; // Wait for more data
      }

      const entryData = this.buffer.subarray(5, 5 + entryLength);
      this.buffer = this.buffer.subarray(totalSize);

      try {
        const entry = parseSyslogEntry(entryData);
        this.onEntry(entry);
      } catch (error) {
        log.debug(`Failed to parse syslog entry: ${error}`);
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
