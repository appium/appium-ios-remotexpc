import { expect } from 'chai';

import { PlistUID } from '../../src/lib/plist/plist-uid.js';
import { NSKeyedArchiverEncoder } from '../../src/services/ios/dvt/nskeyedarchiver-encoder.js';

describe('NSKeyedArchiver Encoder', function () {
  let encoder: NSKeyedArchiverEncoder;

  beforeEach(function () {
    encoder = new NSKeyedArchiverEncoder();
  });

  describe('encode', function () {
    it('should produce a valid NSKeyedArchiver envelope', function () {
      const result = encoder.encode('hello');

      expect(result).to.have.property('$version', 100000);
      expect(result).to.have.property('$archiver', 'NSKeyedArchiver');
      expect(result.$top).to.have.property('root').that.is.instanceOf(PlistUID);
      expect(result.$objects[0]).to.equal('$null');
    });

    it('should encode null/undefined as $null reference (index 0)', function () {
      expect(encoder.encode(null).$top.root.value).to.equal(0);
      expect(
        new NSKeyedArchiverEncoder().encode(undefined).$top.root.value,
      ).to.equal(0);
    });

    it('should encode a string value', function () {
      const result = encoder.encode('test string');

      expect(result.$objects[result.$top.root.value]).to.equal('test string');
    });

    it('should encode a numeric value', function () {
      const result = encoder.encode(42);

      expect(result.$objects[result.$top.root.value]).to.equal(42);
    });

    it('should encode a boolean value', function () {
      const result = encoder.encode(true);

      expect(result.$objects[result.$top.root.value]).to.equal(true);
    });

    it('should encode an array as NSArray with element UIDs', function () {
      const result = encoder.encode(['a', 'b', 'c']);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const items = arrayObj['NS.objects'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );
      expect(items).to.deep.equal(['a', 'b', 'c']);

      const classDef = result.$objects[arrayObj.$class.value];
      expect(classDef).to.have.property('$classname', 'NSArray');
      expect(classDef.$classes).to.deep.equal(['NSArray', 'NSObject']);
    });

    it('should map null elements in an array to the $null sentinel', function () {
      const result = encoder.encode([1, null, 'x']);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const items = arrayObj['NS.objects'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );
      expect(items).to.deep.equal([1, '$null', 'x']);
    });

    it('should encode a plain object as NSDictionary with key and value UIDs', function () {
      const result = encoder.encode({ key1: 'value1', key2: 'value2' });
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const keys = dictObj['NS.keys'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );
      const values = dictObj['NS.objects'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );

      expect(keys).to.deep.equal(['key1', 'key2']);
      expect(values).to.deep.equal(['value1', 'value2']);

      const classDef = result.$objects[dictObj.$class.value];
      expect(classDef).to.have.property('$classname', 'NSDictionary');
      expect(classDef.$classes).to.deep.equal(['NSDictionary', 'NSObject']);
    });

    it('should encode a Buffer as NSMutableData', function () {
      const buf = Buffer.from([0x01, 0x02, 0x03]);
      const result = encoder.encode(buf);
      const rootIdx = result.$top.root.value;
      const dataObj = result.$objects[rootIdx];

      expect(dataObj['NS.data']).to.deep.equal(buf);

      const classDef = result.$objects[dataObj.$class.value];
      expect(classDef).to.have.property('$classname', 'NSMutableData');
      expect(classDef.$classes).to.deep.equal([
        'NSMutableData',
        'NSData',
        'NSObject',
      ]);
    });

    it('should encode nested dictionaries inside an array', function () {
      const result = encoder.encode([{ id: 'a' }, { id: 'b' }]);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      for (const uid of arrayObj['NS.objects']) {
        const dictObj = result.$objects[uid.value];
        expect(dictObj).to.have.property('NS.keys');
        expect(dictObj).to.have.property('NS.objects');
      }
    });

    it('should encode a nested array inside a dictionary', function () {
      const result = encoder.encode({ items: ['x', 'y'] });
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const nestedArray = result.$objects[dictObj['NS.objects'][0].value];
      const items = nestedArray['NS.objects'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );
      expect(items).to.deep.equal(['x', 'y']);
    });

    it('should deduplicate identical object references via the cache', function () {
      const shared = { reused: true };
      const result = encoder.encode([shared, shared]);

      const rootIdx = result.$top.root.value;
      const [uid1, uid2] = result.$objects[rootIdx]['NS.objects'];

      expect(uid1.value).to.equal(uid2.value);
    });

    it('should handle circular references without infinite recursion', function () {
      const obj: any = { name: 'root' };
      obj.self = obj;

      const result = encoder.encode(obj);
      const rootIdx = result.$top.root.value;
      const dictObj = result.$objects[rootIdx];

      const keys = dictObj['NS.keys'].map(
        (uid: PlistUID) => result.$objects[uid.value],
      );
      const valUids = dictObj['NS.objects'];

      expect(keys).to.deep.equal(['name', 'self']);
      // The 'self' value UID should point back to the root dictionary itself
      expect(valUids[1].value).to.equal(rootIdx);
    });

    it('should reuse class definitions across objects of the same type', function () {
      const result = encoder.encode([{ a: 1 }, { b: 2 }]);
      const rootIdx = result.$top.root.value;
      const arrayObj = result.$objects[rootIdx];

      const dict1 = result.$objects[arrayObj['NS.objects'][0].value];
      const dict2 = result.$objects[arrayObj['NS.objects'][1].value];

      expect(dict1.$class.value).to.equal(dict2.$class.value);
    });

    it('should throw for unsupported types', function () {
      expect(() => encoder.encode(Symbol('test'))).to.throw(
        'Unsupported type for NSKeyedArchiver: symbol',
      );
    });
  });
});
