import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {generateHostId} from '../../../../src/lib/apple-tv/utils/uuid-generator.js';

describe('uuid-generator', () => {
  describe('generateHostId', () => {
    it('should generate deterministic UUID from hostname', () => {
      const hostname = 'example.com';
      const uuid1 = generateHostId(hostname);
      const uuid2 = generateHostId(hostname);

      assert.strictEqual(uuid1, uuid2);
      assert.match(uuid1, /^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    });

    it('should generate different UUIDs for different hostnames', () => {
      const uuid1 = generateHostId('example.com');
      const uuid2 = generateHostId('test.com');

      assert.notStrictEqual(uuid1, uuid2);
    });

    it('should throw error for empty string', () => {
      assert.throws(
        () => generateHostId(''),
        (err: any) => err instanceof TypeError && err.message.includes('Hostname must be a non-empty string'),
      );
    });

    it('should throw error for non-string input', () => {
      assert.throws(
        () => generateHostId(null as any),
        (err: any) => err instanceof TypeError && err.message.includes('Hostname must be a non-empty string'),
      );
    });
  });
});
