import { expect } from 'chai';

import { generateHostId } from '../../../../src/lib/apple-tv/utils/uuid-generator.js';

describe('uuid-generator', () => {
  describe('generateHostId', () => {
    it('should generate deterministic UUID from hostname', () => {
      const hostname = 'example.com';
      const uuid1 = generateHostId(hostname);
      const uuid2 = generateHostId(hostname);

      expect(uuid1).to.equal(uuid2);
      expect(uuid1).to.match(
        /^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
      );
    });

    it('should generate different UUIDs for different hostnames', () => {
      const uuid1 = generateHostId('example.com');
      const uuid2 = generateHostId('test.com');

      expect(uuid1).to.not.equal(uuid2);
    });

    it('should throw error for empty string', () => {
      expect(() => generateHostId('')).to.throw(
        TypeError,
        'Hostname must be a non-empty string',
      );
    });

    it('should throw error for non-string input', () => {
      expect(() => generateHostId(null as any)).to.throw(
        TypeError,
        'Hostname must be a non-empty string',
      );
    });
  });
});
