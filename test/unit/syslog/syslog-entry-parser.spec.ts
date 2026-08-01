import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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
  const subsystemBytes = subsystem ? Buffer.from(subsystem + '\0', 'utf8') : Buffer.alloc(0);
  const categoryBytes = category ? Buffer.from(category + '\0', 'utf8') : Buffer.alloc(0);

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
      assert.strictEqual(getLogLevelName(SyslogLogLevel.Notice), 'NOTICE');
      assert.strictEqual(getLogLevelName(SyslogLogLevel.Info), 'INFO');
      assert.strictEqual(getLogLevelName(SyslogLogLevel.Debug), 'DEBUG');
      assert.strictEqual(getLogLevelName(SyslogLogLevel.UserAction), 'USER_ACTION');
      assert.strictEqual(getLogLevelName(SyslogLogLevel.Error), 'ERROR');
      assert.strictEqual(getLogLevelName(SyslogLogLevel.Fault), 'FAULT');
    });

    it('should return UNKNOWN with hex value for unknown log levels', function () {
      assert.strictEqual(getLogLevelName(0xff), 'UNKNOWN(0xff)');
      assert.strictEqual(getLogLevelName(0x20), 'UNKNOWN(0x20)');
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

      assert.strictEqual(entry.pid, 5678);
      assert.strictEqual(entry.timestampSeconds, 1700000000);
      assert.strictEqual(entry.timestampMicroseconds, 123456);
      assert.strictEqual(entry.level, SyslogLogLevel.Debug);
      assert.strictEqual(entry.levelName, 'DEBUG');
      assert.strictEqual(entry.filename, '/usr/bin/testapp');
      assert.strictEqual(entry.imageName, 'TestApp');
      assert.strictEqual(entry.message, 'Hello World');
      assert.strictEqual(entry.imageOffset, 0x2000);
      assert.deepStrictEqual(entry.label, {
        subsystem: 'com.example.test',
        category: 'networking',
      });
      assert.ok(entry.timestamp instanceof Date);
    });

    it('should parse an entry without label', function () {
      const entryData = createSyslogEntryBuffer({
        message: 'Message without label',
      });

      const entry = parseSyslogEntry(entryData);

      assert.strictEqual(entry.message, 'Message without label');
      assert.strictEqual(entry.label, undefined);
    });

    it('should parse an entry with empty strings', function () {
      const entryData = createSyslogEntryBuffer({
        imageName: '',
        message: '',
      });

      const entry = parseSyslogEntry(entryData);

      assert.strictEqual(entry.imageName, '');
      assert.strictEqual(entry.message, '');
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
        const entryData = createSyslogEntryBuffer({level});
        const entry = parseSyslogEntry(entryData);
        assert.strictEqual(entry.level, level);
      }
    });

    it('should throw error for entry data that is too short', function () {
      const tooShort = Buffer.alloc(100);
      assert.throws(
        () => parseSyslogEntry(tooShort),
        (err: any) => err.message.includes('Entry data too short'),
      );
    });

    it('should throw error when filename null terminator is missing', function () {
      const buffer = Buffer.alloc(200);
      buffer.fill(0xff, 129); // Fill with non-null bytes
      assert.throws(
        () => parseSyslogEntry(buffer),
        (err: any) => err.message.includes('Could not find null terminator for filename'),
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
      assert.strictEqual(entry.timestamp.getTime(), expectedMs);
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

      assert.ok(formatted.includes('myapp'));
      assert.ok(formatted.includes('MyApp'));
      assert.ok(formatted.includes('[1234]'));
      assert.ok(formatted.includes('<INFO>'));
      assert.ok(formatted.includes('Test message'));
      assert.ok(formatted.includes('[com.example.app][network]'));
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

      assert.ok(formatted.includes('myapp'));
      assert.ok(formatted.includes('ERROR'));
      assert.ok(formatted.includes('Error occurred'));
      assert.ok(!formatted.includes('[][]'));
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

      assert.ok(formatted.includes('MyApp'));
      assert.ok(formatted.includes('Foundation'));
      assert.ok(!formatted.includes('/System/Library'));
      assert.ok(!formatted.includes('/Applications'));
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
      assert.match(formatted, new RegExp(`${ESC}\\[\\d+m`));
      // Check for reset code
      assert.ok(formatted.includes(`${ESC}[0m`));
      // Should still contain the content
      assert.ok(formatted.includes('ERROR'));
      assert.ok(formatted.includes('Error message'));
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

      assert.ok(formatted.includes('[com.test][ui]'));
      assert.match(formatted, new RegExp(`${ESC}\\[\\d+m`));
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

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'Single entry test');
      assert.strictEqual(errors.length, 0);
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
      assert.strictEqual(entries.length, 0); // Not complete yet

      parser.addData(chunk2);
      assert.strictEqual(entries.length, 0); // Still not complete

      parser.addData(chunk3);
      assert.strictEqual(entries.length, 1); // Now complete
      assert.strictEqual(entries[0]?.message, 'Fragmented entry');
    });

    it('should parse multiple entries in a single chunk', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entry1Data = createSyslogEntryBuffer({message: 'First'});
      const entry2Data = createSyslogEntryBuffer({message: 'Second'});
      const entry3Data = createSyslogEntryBuffer({message: 'Third'});

      const frame = Buffer.concat([
        createProtocolFrame(entry1Data),
        createProtocolFrame(entry2Data),
        createProtocolFrame(entry3Data),
      ]);

      parser.addData(frame);

      assert.strictEqual(entries.length, 3);
      assert.strictEqual(entries[0]?.message, 'First');
      assert.strictEqual(entries[1]?.message, 'Second');
      assert.strictEqual(entries[2]?.message, 'Third');
    });

    it('should skip garbage data before the marker', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const garbage = Buffer.from('garbage data here');
      const entryData = createSyslogEntryBuffer({message: 'Valid entry'});
      const frame = createProtocolFrame(entryData);

      const dataWithGarbage = Buffer.concat([garbage, frame]);

      parser.addData(dataWithGarbage);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'Valid entry');
    });

    it('should handle false markers with invalid lengths', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Create data with a false marker (0x02) followed by an invalid length
      const falseMarker = Buffer.alloc(5);
      falseMarker.writeUInt8(0x02, 0);
      falseMarker.writeUInt32LE(10, 1); // Too small length (< MIN_ENTRY_SIZE)

      const entryData = createSyslogEntryBuffer({message: 'Valid entry'});
      const validFrame = createProtocolFrame(entryData);

      const combined = Buffer.concat([falseMarker, validFrame]);

      parser.addData(combined);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'Valid entry');
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
      assert.strictEqual(entries.length, 0);

      // Now add a valid entry
      const entryData = createSyslogEntryBuffer({message: 'Valid entry'});
      const validFrame = createProtocolFrame(entryData);
      parser.addData(validFrame);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'Valid entry');
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

      assert.strictEqual(entries.length, 0);
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0] instanceof Error);
    });

    it('should reset buffer when exceeding maximum size', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Create data larger than MAX_BUFFER_SIZE (10 MB)
      const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);

      parser.addData(hugeBuffer);

      // Buffer should be reset, so no entries parsed
      assert.strictEqual(entries.length, 0);

      // Parser should still work after reset
      const entryData = createSyslogEntryBuffer({message: 'After reset'});
      const frame = createProtocolFrame(entryData);
      parser.addData(frame);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'After reset');
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
      assert.strictEqual(entries.length, 0);
    });

    it('should handle partial marker and length', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entryData = createSyslogEntryBuffer({message: 'Partial test'});
      const frame = createProtocolFrame(entryData);

      // Send only the marker byte
      parser.addData(frame.subarray(0, 1));
      assert.strictEqual(entries.length, 0);

      // Send marker + partial length (3 bytes total, need 5)
      parser.addData(frame.subarray(1, 3));
      assert.strictEqual(entries.length, 0);

      // Send the rest
      parser.addData(frame.subarray(3));
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'Partial test');
    });

    it('should handle reset method', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      const entryData = createSyslogEntryBuffer({message: 'Before reset'});
      const frame = createProtocolFrame(entryData);

      // Send partial data
      parser.addData(frame.subarray(0, 50));
      assert.strictEqual(entries.length, 0);

      // Reset the parser
      parser.reset();

      // Send a complete new entry
      const newEntryData = createSyslogEntryBuffer({
        message: 'After reset',
      });
      const newFrame = createProtocolFrame(newEntryData);
      parser.addData(newFrame);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.message, 'After reset');
    });

    it('should handle no marker in buffer', function () {
      const entries: SyslogEntry[] = [];
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Send data with no 0x02 marker
      const noMarker = Buffer.from('This has no marker byte');
      parser.addData(noMarker);

      assert.strictEqual(entries.length, 0);
    });

    it('should work with default error callback', function () {
      const entries: SyslogEntry[] = [];
      // Create parser without error callback (uses default no-op)
      const parser = new SyslogProtocolParser((entry) => entries.push(entry));

      // Send invalid data that will cause parsing error
      const invalidEntryData = Buffer.alloc(100);
      const frame = createProtocolFrame(invalidEntryData);

      // Should not throw even without error handler
      assert.doesNotThrow(() => parser.addData(frame));
      assert.strictEqual(entries.length, 0);
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
      assert.strictEqual(entries.length, 0);

      // Send: rest of frame1 + frame2
      const chunk2 = Buffer.concat([frame1.subarray(100), frame2]);
      parser.addData(chunk2);

      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0]?.pid, 100);
      assert.strictEqual(entries[0]?.message, 'First log');
      assert.strictEqual(entries[1]?.pid, 200);
      assert.strictEqual(entries[1]?.message, 'Second log');
      assert.deepStrictEqual(entries[1]?.label, {
        subsystem: 'com.test',
        category: 'network',
      });
    });
  });
});
