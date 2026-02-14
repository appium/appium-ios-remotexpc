import { expect } from 'chai';

import {
  type SyslogEntry,
  SyslogLogLevel,
  SyslogProtocolParser,
  formatSyslogEntry,
  formatSyslogEntryColored,
  getLogLevelName,
  parseSyslogEntry,
} from '../../../src/services/ios/syslog-service/syslog-entry-parser.js';

// ESC character for ANSI escape sequences
const ESC = String.fromCharCode(27);

/**
 * Helper function to create a valid syslog entry buffer for testing.
 * Mimics the os_trace_relay binary protocol format.
 */
function createSyslogEntryBuffer(options: {
  pid?: number;
  timestampSeconds?: number;
  timestampMicroseconds?: number;
  level?: SyslogLogLevel;
  filename?: string;
  imageName?: string;
  message?: string;
  imageOffset?: number;
  subsystem?: string;
  category?: string;
}): Buffer {
  const {
    pid = 1234,
    timestampSeconds = 1700000000,
    timestampMicroseconds = 500000,
    level = SyslogLogLevel.Info,
    filename = '/usr/bin/myapp',
    imageName = 'MyApp',
    message = 'Test message',
    imageOffset = 0x1000,
    subsystem = '',
    category = '',
  } = options;

  // Add null terminators to strings
  const filenameBytes = Buffer.from(filename + '\0', 'utf8');
  const imageNameBytes = Buffer.from(imageName + '\0', 'utf8');
  const messageBytes = Buffer.from(message + '\0', 'utf8');
  const subsystemBytes = subsystem
    ? Buffer.from(subsystem + '\0', 'utf8')
    : Buffer.alloc(0);
  const categoryBytes = category
    ? Buffer.from(category + '\0', 'utf8')
    : Buffer.alloc(0);

  const headerSize = 129;
  const totalSize =
    headerSize +
    filenameBytes.length +
    imageNameBytes.length +
    messageBytes.length +
    subsystemBytes.length +
    categoryBytes.length;

  const buffer = Buffer.alloc(totalSize);

  // Fill header with zeros (skip fields at offset 0-8)
  buffer.fill(0, 0, headerSize);

  // Write fields at their specific offsets
  buffer.writeUInt32LE(pid, 9);
  buffer.writeUInt32LE(timestampSeconds, 55);
  buffer.writeUInt32LE(timestampMicroseconds, 63);
  buffer.writeUInt8(level, 68);
  buffer.writeUInt16LE(imageNameBytes.length, 107);
  buffer.writeUInt16LE(messageBytes.length, 109);
  buffer.writeUInt32LE(imageOffset, 113);
  buffer.writeUInt32LE(subsystemBytes.length, 117);
  buffer.writeUInt32LE(categoryBytes.length, 121);

  // Write variable-length fields
  let offset = 129;
  filenameBytes.copy(buffer, offset);
  offset += filenameBytes.length;
  imageNameBytes.copy(buffer, offset);
  offset += imageNameBytes.length;
  messageBytes.copy(buffer, offset);
  offset += messageBytes.length;
  if (subsystemBytes.length > 0) {
    subsystemBytes.copy(buffer, offset);
    offset += subsystemBytes.length;
  }
  if (categoryBytes.length > 0) {
    categoryBytes.copy(buffer, offset);
  }

  return buffer;
}

/**
 * Helper function to create a complete protocol frame with marker and length.
 */
function createProtocolFrame(entryData: Buffer): Buffer {
  const frame = Buffer.alloc(5 + entryData.length);
  frame.writeUInt8(0x02, 0); // ENTRY_MARKER
  frame.writeUInt32LE(entryData.length, 1);
  entryData.copy(frame, 5);
  return frame;
}

describe('syslog-entry-parser', function () {
  describe('getLogLevelName', function () {
    it('should return correct name for known log levels', function () {
      expect(getLogLevelName(SyslogLogLevel.Notice)).to.equal('NOTICE');
      expect(getLogLevelName(SyslogLogLevel.Info)).to.equal('INFO');
      expect(getLogLevelName(SyslogLogLevel.Debug)).to.equal('DEBUG');
      expect(getLogLevelName(SyslogLogLevel.UserAction)).to.equal(
        'USER_ACTION',
      );
      expect(getLogLevelName(SyslogLogLevel.Error)).to.equal('ERROR');
      expect(getLogLevelName(SyslogLogLevel.Fault)).to.equal('FAULT');
    });

    it('should return UNKNOWN with hex value for unknown log levels', function () {
      expect(getLogLevelName(0xff)).to.equal('UNKNOWN(0xff)');
      expect(getLogLevelName(0x20)).to.equal('UNKNOWN(0x20)');
    });
  });

  describe('parseSyslogEntry', function () {
    it('should parse a valid entry with all fields', function () {
      const entryData = createSyslogEntryBuffer({
        pid: 5678,
        timestampSeconds: 1700000000,
        timestampMicroseconds: 123456,
        level: SyslogLogLevel.Debug,
        filename: '/usr/bin/testapp',
        imageName: 'TestApp',
        message: 'Hello World',
        imageOffset: 0x2000,
        subsystem: 'com.example.test',
        category: 'networking',
      });

      const entry = parseSyslogEntry(entryData);

      expect(entry.pid).to.equal(5678);
      expect(entry.timestampSeconds).to.equal(1700000000);
      expect(entry.timestampMicroseconds).to.equal(123456);
      expect(entry.level).to.equal(SyslogLogLevel.Debug);
      expect(entry.levelName).to.equal('DEBUG');
      expect(entry.filename).to.equal('/usr/bin/testapp');
      expect(entry.imageName).to.equal('TestApp');
      expect(entry.message).to.equal('Hello World');
      expect(entry.imageOffset).to.equal(0x2000);
      expect(entry.label).to.deep.equal({
        subsystem: 'com.example.test',
        category: 'networking',
      });
      expect(entry.timestamp).to.be.instanceOf(Date);
    });

    it('should parse an entry without label', function () {
      const entryData = createSyslogEntryBuffer({
        message: 'Message without label',
      });

      const entry = parseSyslogEntry(entryData);

      expect(entry.message).to.equal('Message without label');
      expect(entry.label).to.be.undefined;
    });

    it('should parse an entry with empty strings', function () {
      const entryData = createSyslogEntryBuffer({
        imageName: '',
        message: '',
      });

      const entry = parseSyslogEntry(entryData);

      expect(entry.imageName).to.equal('');
      expect(entry.message).to.equal('');
    });

    it('should handle different log levels', function () {
      for (const level of [
        SyslogLogLevel.Notice,
        SyslogLogLevel.Info,
        SyslogLogLevel.Debug,
        SyslogLogLevel.UserAction,
        SyslogLogLevel.Error,
        SyslogLogLevel.Fault,
      ]) {
        const entryData = createSyslogEntryBuffer({ level });
        const entry = parseSyslogEntry(entryData);
        expect(entry.level).to.equal(level);
      }
    });

    it('should throw error for entry data that is too short', function () {
      const tooShort = Buffer.alloc(100);
      expect(() => parseSyslogEntry(tooShort)).to.throw('Entry data too short');
    });

    it('should throw error when filename null terminator is missing', function () {
      const buffer = Buffer.alloc(200);
      buffer.fill(0xff, 129); // Fill with non-null bytes
      expect(() => parseSyslogEntry(buffer)).to.throw(
        'Could not find null terminator for filename',
      );
    });

    it('should correctly calculate timestamp from seconds and microseconds', function () {
      const seconds = 1700000000;
      const microseconds = 500000;
      const entryData = createSyslogEntryBuffer({
        timestampSeconds: seconds,
        timestampMicroseconds: microseconds,
      });

      const entry = parseSyslogEntry(entryData);

      const expectedMs = seconds * 1000 + microseconds / 1000;
      expect(entry.timestamp.getTime()).to.equal(expectedMs);
    });
  });

  describe('formatSyslogEntry', function () {
    it('should format entry with all fields', function () {
      const entry: SyslogEntry = {
        pid: 1234,
        timestamp: new Date(1700000000500),
        timestampSeconds: 1700000000,
        timestampMicroseconds: 500000,
        level: SyslogLogLevel.Info,
        levelName: 'INFO',
        imageName: '/path/to/MyApp',
        imageOffset: 0x1000,
        filename: '/usr/bin/myapp',
        message: 'Test message',
        label: {
          subsystem: 'com.example.app',
          category: 'network',
        },
      };

      const formatted = formatSyslogEntry(entry);

      expect(formatted).to.include('myapp');
      expect(formatted).to.include('MyApp');
      expect(formatted).to.include('[1234]');
      expect(formatted).to.include('<INFO>');
      expect(formatted).to.include('Test message');
      expect(formatted).to.include('[com.example.app][network]');
    });

    it('should format entry without label', function () {
      const entry: SyslogEntry = {
        pid: 1234,
        timestamp: new Date(),
        timestampSeconds: 1700000000,
        timestampMicroseconds: 0,
        level: SyslogLogLevel.Error,
        levelName: 'ERROR',
        imageName: 'MyApp',
        imageOffset: 0,
        filename: '/usr/bin/myapp',
        message: 'Error occurred',
      };

      const formatted = formatSyslogEntry(entry);

      expect(formatted).to.include('myapp');
      expect(formatted).to.include('ERROR');
      expect(formatted).to.include('Error occurred');
      expect(formatted).not.to.include('[][]');
    });

    it('should extract basename from paths', function () {
      const entry: SyslogEntry = {
        pid: 1234,
        timestamp: new Date(),
        timestampSeconds: 1700000000,
        timestampMicroseconds: 0,
        level: SyslogLogLevel.Debug,
        levelName: 'DEBUG',
        imageName: '/System/Library/Frameworks/Foundation.framework/Foundation',
        imageOffset: 0,
        filename: '/Applications/MyApp.app/Contents/MacOS/MyApp',
        message: 'Debug info',
      };

      const formatted = formatSyslogEntry(entry);

      expect(formatted).to.include('MyApp');
      expect(formatted).to.include('Foundation');
      expect(formatted).not.to.include('/System/Library');
      expect(formatted).not.to.include('/Applications');
    });
  });

  describe('formatSyslogEntryColored', function () {
    it('should include ANSI color codes', function () {
      const entry: SyslogEntry = {
        pid: 1234,
        timestamp: new Date(),
        timestampSeconds: 1700000000,
        timestampMicroseconds: 0,
        level: SyslogLogLevel.Error,
        levelName: 'ERROR',
        imageName: 'MyApp',
        imageOffset: 0,
        filename: '/usr/bin/myapp',
        message: 'Error message',
      };

      const formatted = formatSyslogEntryColored(entry);

      // Check for ANSI escape sequences
      expect(formatted).to.match(new RegExp(`${ESC}\\[\\d+m`));
      // Check for reset code
      expect(formatted).to.include(`${ESC}[0m`);
      // Should still contain the content
      expect(formatted).to.include('ERROR');
      expect(formatted).to.include('Error message');
    });

    it('should format entry with label using colors', function () {
      const entry: SyslogEntry = {
        pid: 1234,
        timestamp: new Date(),
        timestampSeconds: 1700000000,
        timestampMicroseconds: 0,
        level: SyslogLogLevel.Debug,
        levelName: 'DEBUG',
        imageName: 'MyApp',
        imageOffset: 0,
        filename: '/usr/bin/myapp',
        message: 'Debug message',
        label: {
          subsystem: 'com.test',
          category: 'ui',
        },
      };

      const formatted = formatSyslogEntryColored(entry);

      expect(formatted).to.include('[com.test][ui]');
      expect(formatted).to.match(new RegExp(`${ESC}\\[\\d+m`));
    });
  });

  describe('SyslogProtocolParser', function () {
    it('should parse a single complete entry', function () {
      const entries: SyslogEntry[] = [];
      const errors: Error[] = [];
      const parser = new SyslogProtocolParser(
        (entry) => entries.push(entry),
        (error) => errors.push(error),
      );

      const entryData = createSyslogEntryBuffer({
        message: 'Single entry test',
      });
      const frame = createProtocolFrame(entryData);

      parser.addData(frame);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('Single entry test');
      expect(errors).to.have.lengthOf(0);
    });

    it('should handle fragmented data across multiple chunks', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entryData = createSyslogEntryBuffer({
        message: 'Fragmented entry',
      });
      const frame = createProtocolFrame(entryData);

      // Split frame into three chunks
      const chunk1 = frame.subarray(0, 50);
      const chunk2 = frame.subarray(50, 100);
      const chunk3 = frame.subarray(100);

      parser.addData(chunk1);
      expect(entries).to.have.lengthOf(0); // Not complete yet

      parser.addData(chunk2);
      expect(entries).to.have.lengthOf(0); // Still not complete

      parser.addData(chunk3);
      expect(entries).to.have.lengthOf(1); // Now complete
      expect(entries[0]?.message).to.equal('Fragmented entry');
    });

    it('should parse multiple entries in a single chunk', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entry1Data = createSyslogEntryBuffer({ message: 'First' });
      const entry2Data = createSyslogEntryBuffer({ message: 'Second' });
      const entry3Data = createSyslogEntryBuffer({ message: 'Third' });

      const frame = Buffer.concat([
        createProtocolFrame(entry1Data),
        createProtocolFrame(entry2Data),
        createProtocolFrame(entry3Data),
      ]);

      parser.addData(frame);

      expect(entries).to.have.lengthOf(3);
      expect(entries[0]?.message).to.equal('First');
      expect(entries[1]?.message).to.equal('Second');
      expect(entries[2]?.message).to.equal('Third');
    });

    it('should skip garbage data before the marker', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const garbage = Buffer.from('garbage data here');
      const entryData = createSyslogEntryBuffer({ message: 'Valid entry' });
      const frame = createProtocolFrame(entryData);

      const dataWithGarbage = Buffer.concat([garbage, frame]);

      parser.addData(dataWithGarbage);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('Valid entry');
    });

    it('should handle false markers with invalid lengths', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Create data with a false marker (0x02) followed by an invalid length
      const falseMarker = Buffer.alloc(5);
      falseMarker.writeUInt8(0x02, 0);
      falseMarker.writeUInt32LE(10, 1); // Too small length (< MIN_ENTRY_SIZE)

      const entryData = createSyslogEntryBuffer({ message: 'Valid entry' });
      const validFrame = createProtocolFrame(entryData);

      const combined = Buffer.concat([falseMarker, validFrame]);

      parser.addData(combined);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('Valid entry');
    });

    it('should handle entry length that exceeds maximum', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Create a false marker with length > MAX_ENTRY_SIZE
      const falseMarker = Buffer.alloc(5);
      falseMarker.writeUInt8(0x02, 0);
      falseMarker.writeUInt32LE(100000, 1); // Exceeds MAX_ENTRY_SIZE (65536)

      parser.addData(falseMarker);

      // Parser should skip this false marker and continue
      expect(entries).to.have.lengthOf(0);

      // Now add a valid entry
      const entryData = createSyslogEntryBuffer({ message: 'Valid entry' });
      const validFrame = createProtocolFrame(entryData);
      parser.addData(validFrame);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('Valid entry');
    });

    it('should call error callback when entry parsing fails', function () {
      const entries: SyslogEntry[] = [];
      const errors: Error[] = [];
      const parser = new SyslogProtocolParser(
        (entry) => entries.push(entry),
        (error) => errors.push(error),
      );

      // Create a frame with valid marker/length but invalid entry data
      const invalidEntryData = Buffer.alloc(100); // Too short for valid entry
      const frame = createProtocolFrame(invalidEntryData);

      parser.addData(frame);

      expect(entries).to.have.lengthOf(0);
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.be.instanceOf(Error);
    });

    it('should reset buffer when exceeding maximum size', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Create data larger than MAX_BUFFER_SIZE (10 MB)
      const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);

      parser.addData(hugeBuffer);

      // Buffer should be reset, so no entries parsed
      expect(entries).to.have.lengthOf(0);

      // Parser should still work after reset
      const entryData = createSyslogEntryBuffer({ message: 'After reset' });
      const frame = createProtocolFrame(entryData);
      parser.addData(frame);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('After reset');
    });

    it('should reset buffer when accumulated data would exceed limit', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Add data that's just under the limit
      const largeBuffer = Buffer.alloc(9.5 * 1024 * 1024);
      parser.addData(largeBuffer);

      // Add more data that would exceed the limit
      const additionalBuffer = Buffer.alloc(1 * 1024 * 1024);
      parser.addData(additionalBuffer);

      // Buffer should have been reset before adding new data
      expect(entries).to.have.lengthOf(0);
    });

    it('should handle partial marker and length', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entryData = createSyslogEntryBuffer({ message: 'Partial test' });
      const frame = createProtocolFrame(entryData);

      // Send only the marker byte
      parser.addData(frame.subarray(0, 1));
      expect(entries).to.have.lengthOf(0);

      // Send marker + partial length (3 bytes total, need 5)
      parser.addData(frame.subarray(1, 3));
      expect(entries).to.have.lengthOf(0);

      // Send the rest
      parser.addData(frame.subarray(3));
      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('Partial test');
    });

    it('should handle reset method', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entryData = createSyslogEntryBuffer({ message: 'Before reset' });
      const frame = createProtocolFrame(entryData);

      // Send partial data
      parser.addData(frame.subarray(0, 50));
      expect(entries).to.have.lengthOf(0);

      // Reset the parser
      parser.reset();

      // Send a complete new entry
      const newEntryData = createSyslogEntryBuffer({
        message: 'After reset',
      });
      const newFrame = createProtocolFrame(newEntryData);
      parser.addData(newFrame);

      expect(entries).to.have.lengthOf(1);
      expect(entries[0]?.message).to.equal('After reset');
    });

    it('should handle no marker in buffer', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Send data with no 0x02 marker
      const noMarker = Buffer.from('This has no marker byte');
      parser.addData(noMarker);

      expect(entries).to.have.lengthOf(0);
    });

    it('should work with default error callback', function () {
      const entries: SyslogEntry[] = [];
      // Create parser without error callback (uses default no-op)
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Send invalid data that will cause parsing error
      const invalidEntryData = Buffer.alloc(100);
      const frame = createProtocolFrame(invalidEntryData);

      // Should not throw even without error handler
      expect(() => parser.addData(frame)).not.to.throw();
      expect(entries).to.have.lengthOf(0);
    });

    it('should handle complex real-world scenario', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Simulate real-world scenario: garbage + partial entry + complete entries
      const garbage = Buffer.from('random garbage');
      const entry1Data = createSyslogEntryBuffer({
        pid: 100,
        message: 'First log',
        level: SyslogLogLevel.Info,
      });
      const entry2Data = createSyslogEntryBuffer({
        pid: 200,
        message: 'Second log',
        level: SyslogLogLevel.Error,
        subsystem: 'com.test',
        category: 'network',
      });

      const frame1 = createProtocolFrame(entry1Data);
      const frame2 = createProtocolFrame(entry2Data);

      // Send: garbage + half of frame1
      const chunk1 = Buffer.concat([garbage, frame1.subarray(0, 100)]);
      parser.addData(chunk1);
      expect(entries).to.have.lengthOf(0);

      // Send: rest of frame1 + frame2
      const chunk2 = Buffer.concat([frame1.subarray(100), frame2]);
      parser.addData(chunk2);

      expect(entries).to.have.lengthOf(2);
      expect(entries[0]?.pid).to.equal(100);
      expect(entries[0]?.message).to.equal('First log');
      expect(entries[1]?.pid).to.equal(200);
      expect(entries[1]?.message).to.equal('Second log');
      expect(entries[1]?.label).to.deep.equal({
        subsystem: 'com.test',
        category: 'network',
      });
    });
  });
});
