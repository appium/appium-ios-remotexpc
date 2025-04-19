// Binary structure handling
type StructType = 'H' | 'B' | 'L';

class Struct {
  private readonly types: StructType[];

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
}

// Struct constants
const STRUCT_HBBBL = new Struct('>HBBBL');
const STRUCT_HL = new Struct('>HL');
const STRUCT_LB = new Struct('>LB');
const STRUCT_L = new Struct('>L');
const STRUCT_B = new Struct('>B');

// Stream association types
type StreamAssociation = 'has-stream' | 'no-stream' | 'either';
const STREAM_ASSOC_HAS_STREAM: StreamAssociation = 'has-stream';
const STREAM_ASSOC_NO_STREAM: StreamAssociation = 'no-stream';
const STREAM_ASSOC_EITHER: StreamAssociation = 'either';

// Error classes
class HyperframeError extends Error {}
class InvalidDataError extends HyperframeError {}

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

  protected bodyRepr(): string {
    return rawDataRepr(this.serializeBody());
  }
}

// Specific frame implementations

export class SettingsFrame extends Frame {
  static MAX_CONCURRENT_STREAMS = 0x03;
  static INITIAL_WINDOW_SIZE = 0x04;

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

  serializePriorityData(): Buffer {
    return STRUCT_LB.pack(
      this.dependsOn + (this.exclusive ? 0x80000000 : 0),
      this.streamWeight,
    );
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
}

// Exported constants and types
export { InvalidDataError, STRUCT_HL };
