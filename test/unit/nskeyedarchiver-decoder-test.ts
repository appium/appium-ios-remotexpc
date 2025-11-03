import { expect } from 'chai';

import { NSKeyedArchiverDecoder, decodeNSKeyedArchiver } from '../../src/services/ios/dvt/index.js';

describe('NSKeyedArchiver Decoder', () => {
  describe('isNSKeyedArchive', () => {
    it('should identify NSKeyedArchiver format', () => {
      const validArchive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: ['$null', 'test'],
      };

      expect(NSKeyedArchiverDecoder.isNSKeyedArchive(validArchive)).to.be.true;
    });

    it('should reject non-NSKeyedArchiver format', () => {
      expect(NSKeyedArchiverDecoder.isNSKeyedArchive(null)).to.be.false;
      expect(NSKeyedArchiverDecoder.isNSKeyedArchive(undefined)).to.be.false;
      expect(NSKeyedArchiverDecoder.isNSKeyedArchive('string')).to.be.false;
      expect(NSKeyedArchiverDecoder.isNSKeyedArchive([])).to.be.false;
      expect(NSKeyedArchiverDecoder.isNSKeyedArchive({ someKey: 'value' })).to.be.false;
    });
  });

  describe('decode', () => {
    it('should decode simple primitive values', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: ['$null', 'Hello World'],
      };

      const result = decodeNSKeyedArchiver(archive);
      expect(result).to.equal('Hello World');
    });

    it('should decode simple arrays', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3, 4],
            $class: 5,
          },
          'item1',
          'item2',
          'item3',
          { $classname: 'NSArray' },
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      expect(result).to.deep.equal(['item1', 'item2', 'item3']);
    });

    it('should decode dictionaries', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: [
          '$null',
          {
            'NS.keys': [2, 3],
            'NS.objects': [4, 5],
            $class: 6,
          },
          'key1',
          'key2',
          'value1',
          'value2',
          { $classname: 'NSDictionary' },
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      expect(result).to.deep.equal({
        key1: 'value1',
        key2: 'value2',
      });
    });

    it('should decode nested structures (array of dictionaries)', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3],
            $class: 10,
          },
          {
            'NS.keys': [4, 5],
            'NS.objects': [6, 7],
            $class: 9,
          },
          {
            'NS.keys': [4, 5],
            'NS.objects': [8, 7],
            $class: 9,
          },
          'identifier',
          'name',
          'group1',
          'test1',
          'group2',
          { $classname: 'NSDictionary' },
          { $classname: 'NSArray' },
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(2);
      expect(result[0]).to.deep.equal({
        identifier: 'group1',
        name: 'test1',
      });
      expect(result[1]).to.deep.equal({
        identifier: 'group2',
        name: 'test1',
      });
    });

    it('should return non-archived data as-is', () => {
      const plainData = { key: 'value' };
      const result = decodeNSKeyedArchiver(plainData);
      expect(result).to.deep.equal(plainData);

      const arrayData = [1, 2, 3];
      const result2 = decodeNSKeyedArchiver(arrayData);
      expect(result2).to.deep.equal(arrayData);

      const stringData = 'plain string';
      const result3 = decodeNSKeyedArchiver(stringData);
      expect(result3).to.equal(stringData);
    });

    it('should handle null and undefined', () => {
      expect(decodeNSKeyedArchiver(null)).to.be.null;
      expect(decodeNSKeyedArchiver(undefined)).to.be.undefined;
    });

    it('should handle complex condition inducer response structure', () => {
      // Simplified version of the actual condition inducer response
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: { root: 1 },
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3], // Array of condition groups
            $class: 100,
          },
          // First condition group
          {
            'NS.keys': [4, 5, 6],
            'NS.objects': [7, 8, 9],
            $class: 99,
          },
          // Second condition group
          {
            'NS.keys': [4, 5, 6],
            'NS.objects': [10, 11, 12],
            $class: 99,
          },
          // Keys
          'identifier',
          'name',
          'profiles',
          // Values for first group
          'NetworkLink',
          'Network Link',
          {
            'NS.objects': [13],
            $class: 100,
          },
          // Values for second group
          'GPUPerformanceState',
          'GPU Performance State',
          {
            'NS.objects': [14],
            $class: 100,
          },
          // Profile for NetworkLink
          {
            'NS.keys': [4, 15],
            'NS.objects': [16, 17],
            $class: 99,
          },
          // Profile for GPUPerformanceState
          {
            'NS.keys': [4, 15],
            'NS.objects': [18, 19],
            $class: 99,
          },
          'description',
          'NetworkLink3G',
          '3G Network',
          'GPUPerformanceStateMin',
          'Minimum GPU Performance',
          { $classname: 'NSDictionary' },
          { $classname: 'NSArray' },
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(2);
      
      // Check first group
      expect(result[0]).to.have.property('identifier', 'NetworkLink');
      expect(result[0]).to.have.property('name', 'Network Link');
      expect(result[0]).to.have.property('profiles');
      expect(result[0].profiles).to.be.an('array');
      expect(result[0].profiles).to.have.lengthOf(1);
      expect(result[0].profiles[0]).to.have.property('identifier', 'NetworkLink3G');
      expect(result[0].profiles[0]).to.have.property('description', '3G Network');
      
      // Check second group
      expect(result[1]).to.have.property('identifier', 'GPUPerformanceState');
      expect(result[1]).to.have.property('name', 'GPU Performance State');
      expect(result[1]).to.have.property('profiles');
      expect(result[1].profiles).to.be.an('array');
      expect(result[1].profiles).to.have.lengthOf(1);
      expect(result[1].profiles[0]).to.have.property('identifier', 'GPUPerformanceStateMin');
      expect(result[1].profiles[0]).to.have.property('description', 'Minimum GPU Performance');
    });
  });
});
