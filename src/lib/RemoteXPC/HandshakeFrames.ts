// Binary structure handling
type StructType = 'H' | 'B' | 'L';

class Struct {
  private types: StructType[];

  constructor(fmt: string) {
    if (!fmt.startsWith('>')) {
      throw new Error('Only big-endian formats supported');
    }

    this.types = [];
    for (const ch of fmt.slice(1)) {
      if ('0123456789'.includes(ch)) continue;
      this.types.push(ch as StructType);
    }
  }

  byteLength(): number {
    let total = 0;
    for (const t of this.types) {
      if (t === 'H') total += 2;
      else if (t === 'B') total += 1;
      else if (t === 'L') total += 4;
      else throw new Error('Unsupported type: ' + t);
    }
    return total;
  }

  pack(...values: number[]): Buffer {
    if (values.length !== this.types.length) {
      throw new Error('Incorrect number of values to pack');
    }
    const buf = Buffer.alloc(this.byteLength());
    let offset = 0;
    for (const [i, t] of this.types.entries()) {
      const v = values[i];
      if (t === 'H') {
        buf.writeUInt16BE(v, offset);
        offset += 2;
      } else if (t === 'B') {
        buf.writeUInt8(v, offset);
        offset += 1;
      } else if (t === 'L') {
        buf.writeUInt32BE(v, offset);
        offset += 4;
      } else {
        throw new Error('Unsupported type: ' + t);
      }
    }
    return buf;
  }

  unpack(buf: Buffer): number[] {
    const total = this.byteLength();
    if (buf.length < total) {
      throw new Error('Buffer too short for unpacking');
    }
    const values: number[] = [];
    let offset = 0;
    for (const t of this.types) {
      if (t === 'H') {
        values.push(buf.readUInt16BE(offset));
        offset += 2;
      } else if (t === 'B') {
        values.push(buf.readUInt8(offset));
        offset += 1;
      } else if (t === 'L') {
        values.push(buf.readUInt32BE(offset));
        offset += 4;
      } else {
        throw new Error('Unsupported type: ' + t);
      }
    }
    return values;
  }
}

// Struct constants
const STRUCT_HBBBL = new Struct('>HBBBL');
const STRUCT_HL = new Struct('>HL');
const STRUCT_LL = new Struct('>LL');
const STRUCT_LB = new Struct('>LB');
const STRUCT_L = new Struct('>L');
const STRUCT_B = new Struct('>B');

// Frame constants
const FRAME_MAX_LEN = Math.pow(2, 14);
const FRAME_MAX_ALLOWED_LEN = Math.pow(2, 24) - 1;

// Stream association types
type StreamAssociation = 'has-stream' | 'no-stream' | 'either';
const STREAM_ASSOC_HAS_STREAM: StreamAssociation = 'has-stream';
const STREAM_ASSOC_NO_STREAM: StreamAssociation = 'no-stream';
const STREAM_ASSOC_EITHER: StreamAssociation = 'either';

// Error classes
class HyperframeError extends Error {}
class InvalidDataError extends HyperframeError {}
class InvalidFrameError extends HyperframeError {}
class InvalidPaddingError extends HyperframeError {}
class StreamClosedError extends HyperframeError {}

// Flag handling
class Flag {
  name: string;
  bit: number;

  constructor(name: string, bit: number) {
    this.name = name;
    this.bit = bit;
  }
}

class Flags {
  definedFlags: Flag[];
  flags: Set<string>;

  constructor(definedFlags: Flag[]) {
    this.definedFlags = definedFlags;
    this.flags = new Set();
  }

  add(flag: string): void {
    this.flags.add(flag);
  }

  has(flag: string): boolean {
    return this.flags.has(flag);
  }

  toString(): string {
    return Array.from(this.flags).join(', ');
  }
}

// Utility function
function rawDataRepr(data: Buffer | null | undefined): string {
  if (!data || data.length === 0) return 'None';
  let r = data.toString('hex');
  if (r.length > 20) r = r.slice(0, 20) + '...';
  return '<hex:' + r + '>';
}

// Base frame class
export class Frame {
  protected definedFlags: Flag[] = [];
  type: number | null = null;
  streamAssociation: StreamAssociation | null = null;
  streamId: number;
  flags: Flags;
  bodyLen: number;

  constructor(streamId: number, flags: string[] = []) {
    this.streamId = streamId;
    this.flags = new Flags(this.definedFlags);
    this.bodyLen = 0;

    for (const flag of flags) {
      this.flags.add(flag);
    }

    if (!this.streamId && this.streamAssociation === STREAM_ASSOC_HAS_STREAM) {
      throw new InvalidDataError(
        `Stream ID must be non-zero for ${this.constructor.name}`,
      );
    }

    if (this.streamId && this.streamAssociation === STREAM_ASSOC_NO_STREAM) {
      throw new InvalidDataError(
        `Stream ID must be zero for ${this.constructor.name} with streamId=${this.streamId}`,
      );
    }
  }

  toString(): string {
    return `${this.constructor.name}(streamId=${this.streamId}, flags=${this.flags.toString()}): ${this.bodyRepr()}`;
  }

  protected bodyRepr(): string {
    return rawDataRepr(this.serializeBody());
  }

  parseFlags(flagByte: number): Flags {
    for (const f of this.definedFlags) {
      if (flagByte & f.bit) {
        this.flags.add(f.name);
      }
    }
    return this.flags;
  }

  serialize(): Buffer {
    const body = this.serializeBody();
    this.bodyLen = body.length;

    let flagsVal = 0;
    for (const f of this.definedFlags) {
      if (this.flags.has(f.name)) {
        flagsVal |= f.bit;
      }
    }

    const header = STRUCT_HBBBL.pack(
      (this.bodyLen >> 8) & 0xffff,
      this.bodyLen & 0xff,
      this.type!,
      flagsVal,
      this.streamId & 0x7fffffff,
    );

    return Buffer.concat([header, body]);
  }

  serializeBody(): Buffer {
    throw new Error('Not implemented');
  }
}

// Specific frame implementations

export class SettingsFrame extends Frame {
  static HEADER_TABLE_SIZE = 0x01;
  static ENABLE_PUSH = 0x02;
  static MAX_CONCURRENT_STREAMS = 0x03;
  static INITIAL_WINDOW_SIZE = 0x04;
  static MAX_FRAME_SIZE = 0x05;
  static MAX_HEADER_LIST_SIZE = 0x06;
  static ENABLE_CONNECT_PROTOCOL = 0x08;

  settings: Record<number, number>;

  constructor(
    streamId: number = 0,
    settings: Record<number, number> | null = null,
    flags: string[] = [],
  ) {
    super(streamId, flags);
    this.definedFlags = [new Flag('ACK', 0x01)];
    this.type = 0x04;
    this.streamAssociation = STREAM_ASSOC_NO_STREAM;

    if (settings && flags.includes('ACK')) {
      throw new InvalidDataError('Settings must be empty if ACK flag is set.');
    }

    this.settings = settings || {};
  }

  bodyRepr(): string {
    return `settings=${JSON.stringify(this.settings)}`;
  }

  serializeBody(): Buffer {
    if (this.flags.has('ACK')) {
      return Buffer.alloc(0);
    }

    const buffers: Buffer[] = [];
    for (const setting of Object.keys(this.settings)) {
      const buf = STRUCT_HL.pack(
        Number(setting) & 0xff,
        this.settings[Number(setting)],
      );
      buffers.push(buf);
    }

    return Buffer.concat(buffers);
  }

  parseBody(data: Buffer): void {
    if (this.flags.has('ACK') && data.length > 0) {
      throw new InvalidDataError(
        `SETTINGS ack frame must not have payload: got ${data.length} bytes`,
      );
    }

    for (let i = 0; i < data.length; i += 6) {
      let name: number, value: number;
      try {
        [name, value] = STRUCT_HL.unpack(data.slice(i, i + 6));
      } catch (err) {
        throw new InvalidFrameError(`Invalid SETTINGS body: ${err}`);
      }
      this.settings[name] = value;
    }

    this.bodyLen = data.length;
  }
}

export class DataFrame extends Frame {
  data: Buffer;
  padLength: number;

  constructor(
    streamId: number,
    data: Buffer | string = Buffer.from(''),
    flags: string[] = [],
  ) {
    super(streamId, flags);
    this.definedFlags = [
      new Flag('END_STREAM', 0x01),
      new Flag('PADDED', 0x08),
    ];
    this.type = 0x0;
    this.streamAssociation = STREAM_ASSOC_HAS_STREAM;

    this.padLength = 0;
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  serializePaddingData(): Buffer {
    if (this.flags.has('PADDED')) {
      return STRUCT_B.pack(this.padLength);
    }
    return Buffer.alloc(0);
  }

  parsePaddingData(data: Buffer): number {
    if (this.flags.has('PADDED')) {
      try {
        this.padLength = STRUCT_B.unpack(data.slice(0, 1))[0];
        return 1;
      } catch (err) {
        throw new InvalidFrameError(`Invalid Padding data: ${err}`);
      }
    }
    return 0;
  }

  get totalPadding(): number {
    return this.padLength;
  }

  serializeBody(): Buffer {
    const paddingData = this.serializePaddingData();
    const padding = Buffer.alloc(this.padLength, 0);
    // Ensure data is a Buffer
    if (!Buffer.isBuffer(this.data)) {
      this.data = Buffer.from(this.data);
    }
    const payload = Buffer.concat([paddingData, this.data, padding]);
    this.bodyLen = payload.length;
    return payload;
  }

  parseBody(data: Buffer): void {
    const paddingDataLength = this.parsePaddingData(data);
    this.data = data.slice(paddingDataLength, data.length - this.padLength);
    this.bodyLen = data.length;

    if (this.padLength && this.padLength >= this.bodyLen) {
      throw new InvalidPaddingError('Padding is too long.');
    }
  }

  get flowControlledLength(): number {
    let paddingLen = 0;
    if (this.flags.has('PADDED')) {
      paddingLen = this.padLength + 1;
    }
    return this.data.length + paddingLen;
  }
}

export class HeadersFrame extends Frame {
  data: Buffer;
  padLength: number;
  dependsOn: number;
  streamWeight: number;
  exclusive: boolean;
  static ALL_FLAGS: Record<string, number> = {
    END_STREAM: 0x01,
    END_HEADERS: 0x04,
    PADDED: 0x08,
    PRIORITY: 0x20,
  };

  constructor(
    streamId: number,
    data: Buffer | string = Buffer.from(''),
    flags: string[] = [],
  ) {
    super(streamId, flags);
    // Map given flags to Flag objects using ALL_FLAGS
    this.definedFlags = flags.map(
      (flag) => new Flag(flag, HeadersFrame.ALL_FLAGS[flag]),
    );
    this.type = 0x01;
    this.streamAssociation = STREAM_ASSOC_HAS_STREAM;

    this.padLength = 0;
    this.dependsOn = 0;
    this.streamWeight = 0;
    this.exclusive = false;
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  serializePaddingData(): Buffer {
    if (this.flags.has('PADDED')) {
      return STRUCT_B.pack(this.padLength);
    }
    return Buffer.alloc(0);
  }

  parsePaddingData(data: Buffer): number {
    if (this.flags.has('PADDED')) {
      try {
        this.padLength = STRUCT_B.unpack(data.slice(0, 1))[0];
        return 1;
      } catch (err) {
        throw new InvalidFrameError(`Invalid Padding data: ${err}`);
      }
    }
    return 0;
  }

  get totalPadding(): number {
    return this.padLength;
  }

  serializePriorityData(): Buffer {
    return STRUCT_LB.pack(
      this.dependsOn + (this.exclusive ? 0x80000000 : 0),
      this.streamWeight,
    );
  }

  parsePriorityData(data: Buffer): number {
    try {
      const values = STRUCT_LB.unpack(data.slice(0, 5));
      this.dependsOn = values[0];
      this.streamWeight = values[1];
      this.exclusive = Boolean(this.dependsOn >> 31);
      this.dependsOn = this.dependsOn & 0x7fffffff;
      return 5;
    } catch (err) {
      throw new InvalidFrameError(`Invalid Priority data: ${err}`);
    }
  }

  bodyRepr(): string {
    return `exclusive=${this.exclusive}, dependsOn=${this.dependsOn}, streamWeight=${this.streamWeight}, data=${rawDataRepr(this.data)}`;
  }

  serializeBody(): Buffer {
    const paddingData = this.serializePaddingData();
    const padding = Buffer.alloc(this.padLength, 0);
    let priorityData: Buffer;
    if (this.flags.has('PRIORITY')) {
      priorityData = this.serializePriorityData();
    } else {
      priorityData = Buffer.alloc(0);
    }
    return Buffer.concat([paddingData, priorityData, this.data, padding]);
  }

  parseBody(data: Buffer): void {
    const paddingDataLength = this.parsePaddingData(data);
    data = data.slice(paddingDataLength);
    let priorityDataLength: number;
    if (this.flags.has('PRIORITY')) {
      priorityDataLength = this.parsePriorityData(data);
    } else {
      priorityDataLength = 0;
    }
    this.bodyLen = data.length;
    this.data = data.slice(priorityDataLength, data.length - this.padLength);
    if (this.padLength && this.padLength >= this.bodyLen) {
      throw new InvalidPaddingError('Padding is too long.');
    }
  }
}

export class WindowUpdateFrame extends Frame {
  windowIncrement: number;

  constructor(
    streamId: number,
    windowIncrement: number = 0,
    flags: string[] = [],
  ) {
    super(streamId, flags);
    this.definedFlags = [];
    this.type = 0x08;
    this.streamAssociation = STREAM_ASSOC_EITHER;

    this.windowIncrement = windowIncrement;
  }

  bodyRepr(): string {
    return `windowIncrement=${this.windowIncrement}`;
  }

  serializeBody(): Buffer {
    return STRUCT_L.pack(this.windowIncrement & 0x7fffffff);
  }

  parseBody(data: Buffer): void {
    if (data.length > 4) {
      throw new InvalidFrameError(
        `WINDOW_UPDATE frame must have 4 byte length: got ${data.length}`,
      );
    }

    try {
      this.windowIncrement = STRUCT_L.unpack(data)[0];
    } catch (err) {
      throw new InvalidFrameError('Invalid WINDOW_UPDATE body:' + err);
    }

    if (!(this.windowIncrement >= 1 && this.windowIncrement <= 0x7fffffff)) {
      throw new InvalidDataError(
        'WINDOW_UPDATE increment must be between 1 to 2^31-1',
      );
    }

    this.bodyLen = 4;
  }
}

// Exported constants and types
export {
  FRAME_MAX_ALLOWED_LEN,
  FRAME_MAX_LEN,
  InvalidDataError,
  InvalidFrameError,
  InvalidPaddingError,
  STRUCT_HL,
  STRUCT_LL,
  StreamClosedError,
};
