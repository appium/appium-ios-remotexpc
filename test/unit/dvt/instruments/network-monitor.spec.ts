import { expect } from 'chai';

import type { NetworkAddress } from '../../../../src/index.js';
import { NetworkMonitor } from '../../../../src/services/ios/dvt/instruments/network-monitor.js';

describe('NetworkMonitor', function () {
  describe('parseAddress', function () {
    let monitor: NetworkMonitor;

    beforeEach(function () {
      monitor = new NetworkMonitor({} as any);
    });

    describe('IPv4 addresses', function () {
      it('should parse a basic IPv4 address', function () {
        // IPv4 sockaddr structure: 0x10 length, 0x02 family (AF_INET)
        // Port 80 (0x0050), IP 192.168.1.1
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family (AF_INET)
          0x00,
          0x50, // port 80 (big-endian)
          192,
          168,
          1,
          1, // IP address
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00, // padding
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.len).to.equal(0x10);
        expect(result.family).to.equal(2);
        expect(result.port).to.equal(80);
        expect(result.address).to.equal('192.168.1.1');
        expect(result.flowInfo).to.be.undefined;
        expect(result.scopeId).to.be.undefined;
      });

      it('should parse IPv4 with port 443', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x01,
          0xbb, // port 443 (big-endian)
          10,
          0,
          0,
          1, // IP 10.0.0.1
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.port).to.equal(443);
        expect(result.address).to.equal('10.0.0.1');
      });

      it('should parse IPv4 localhost', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x1f,
          0x90, // port 8080
          127,
          0,
          0,
          1, // localhost
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.address).to.equal('127.0.0.1');
        expect(result.port).to.equal(8080);
      });

      it('should parse IPv4 with port 0', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x00,
          0x00, // port 0
          0,
          0,
          0,
          0, // IP 0.0.0.0
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.address).to.equal('0.0.0.0');
        expect(result.port).to.equal(0);
      });
    });

    describe('IPv6 addresses', function () {
      it('should parse a basic IPv6 address', function () {
        // IPv6 sockaddr structure: 0x1c length, 0x1e family (AF_INET6)
        // Port 8080, IPv6 address 2001:0db8:0000:0000:0000:0000:0000:0001
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family (AF_INET6)
          0x1f,
          0x90, // port 8080 (big-endian)
          0x00,
          0x00,
          0x00,
          0x00, // flow info (little-endian)
          0x20,
          0x01, // 2001
          0x0d,
          0xb8, // 0db8
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x01, // 0001
          0x00,
          0x00,
          0x00,
          0x00, // scope ID (little-endian)
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.len).to.equal(0x1c);
        expect(result.family).to.equal(30);
        expect(result.port).to.equal(8080);
        expect(result.address).to.equal('2001:db8:0:0:0:0:0:1');
        expect(result.flowInfo).to.equal(0);
        expect(result.scopeId).to.equal(0);
      });

      it('should parse IPv6 localhost', function () {
        // ::1 (IPv6 localhost)
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family
          0x00,
          0x50, // port 80
          0x00,
          0x00,
          0x00,
          0x00, // flow info
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x01, // 0001
          0x00,
          0x00,
          0x00,
          0x00, // scope ID
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.address).to.equal('0:0:0:0:0:0:0:1');
        expect(result.port).to.equal(80);
      });

      it('should parse IPv6 with non-zero flow info and scope ID', function () {
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family
          0x1f,
          0x90, // port 8080
          0x01,
          0x02,
          0x03,
          0x04, // flow info: 0x04030201 (little-endian)
          0xfe,
          0x80, // fe80 (link-local)
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x02,
          0x15,
          0x5d,
          0xff,
          0xfe,
          0x12,
          0x34,
          0x56,
          0x05,
          0x00,
          0x00,
          0x00, // scope ID: 5 (little-endian)
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.family).to.equal(30);
        expect(result.port).to.equal(8080);
        expect(result.address).to.equal('fe80:0:0:0:215:5dff:fe12:3456');
        expect(result.flowInfo).to.equal(0x04030201);
        expect(result.scopeId).to.equal(5);
      });
    });

    describe('edge cases', function () {
      it('should handle Uint8Array input', function () {
        const uint8Array = new Uint8Array([
          0x10, // length
          0x02, // family
          0x00,
          0x50, // port 80
          192,
          168,
          1,
          1,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(
          uint8Array,
        );

        expect(result.address).to.equal('192.168.1.1');
        expect(result.port).to.equal(80);
      });

      it('should handle high port numbers', function () {
        // Port 65535 (0xFFFF)
        const buffer = Buffer.from([
          0x10,
          0x02,
          0xff,
          0xff, // port 65535
          127,
          0,
          0,
          1,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.port).to.equal(65535);
      });

      it('should format IPv6 addresses with hex values', function () {
        // Test that IPv6 uses hex formatting
        const buffer = Buffer.from([
          0x1c,
          0x1e,
          0x00,
          0x50, // port 80
          0x00,
          0x00,
          0x00,
          0x00, // flow info
          0xab,
          0xcd, // abcd
          0x12,
          0x34, // 1234
          0x56,
          0x78, // 5678
          0x9a,
          0xbc, // 9abc
          0xde,
          0xf0, // def0
          0x11,
          0x22, // 1122
          0x33,
          0x44, // 3344
          0x55,
          0x66, // 5566
          0x00,
          0x00,
          0x00,
          0x00, // scope ID
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        expect(result.address).to.equal(
          'abcd:1234:5678:9abc:def0:1122:3344:5566',
        );
      });
    });
  });
});
