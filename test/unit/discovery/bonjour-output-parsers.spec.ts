import { expect } from 'chai';

import {
  parseBrowseLine,
  parseReachableLine,
  parseTxtRecord,
} from '../../../src/lib/discovery/bonjour-output-parsers.js';

describe('bonjour-output-parsers', function () {
  describe('parseBrowseLine', function () {
    it('parses a single-word service Add line', function () {
      const line =
        '11:52:30.137  Add        2  17 local. _remotepairing-manual-pairing._tcp. Bedroom';
      expect(parseBrowseLine(line)).to.deep.equal({
        action: 'Add',
        service: {
          name: 'Bedroom',
          serviceType: '_remotepairing-manual-pairing._tcp',
          domain: 'local',
        },
      });
    });

    it('preserves spaces in multi-word instance names', function () {
      const line =
        '11:52:30.150  Add        2  17 local. _remotepairing-manual-pairing._tcp. Living Room TV';
      expect(parseBrowseLine(line)).to.have.nested.property(
        'service.name',
        'Living Room TV',
      );
    });

    it('parses Rmv lines as well', function () {
      const line =
        '11:52:30.999  Rmv        2  17 local. _remotepairing._tcp. Office';
      const parsed = parseBrowseLine(line);
      expect(parsed?.action).to.equal('Rmv');
      expect(parsed?.service.name).to.equal('Office');
    });

    it('strips trailing dots from domain and service type', function () {
      const line =
        '11:52:30.137  Add        2  17 local. _remotepairing._tcp. Bedroom';
      const parsed = parseBrowseLine(line);
      expect(parsed?.service.domain).to.equal('local');
      expect(parsed?.service.serviceType).to.equal('_remotepairing._tcp');
    });

    it('returns null for header / banner lines', function () {
      expect(parseBrowseLine('Browsing for _remotepairing._tcp')).to.be.null;
      expect(
        parseBrowseLine(
          'Timestamp     A/R    Flags  if Domain               Service Type            Instance Name',
        ),
      ).to.be.null;
    });

    it('returns null for blank lines', function () {
      expect(parseBrowseLine('')).to.be.null;
      expect(parseBrowseLine('   ')).to.be.null;
    });

    it('returns null when the action token is unrecognized', function () {
      const line =
        '11:52:30.137  Foo        2  17 local. _remotepairing._tcp. Bedroom';
      expect(parseBrowseLine(line)).to.be.null;
    });

    it('returns null when the timestamp does not match dns-sd format', function () {
      const line =
        'NOPE          Add        2  17 local. _remotepairing._tcp. Bedroom';
      expect(parseBrowseLine(line)).to.be.null;
    });

    it('accepts space-padded single-digit hour timestamps', function () {
      // dns-sd renders hours 0-9 with a leading space (e.g. " 8:25:13.882"),
      // which becomes a single digit after trim() + split(/\s+/).
      const line =
        ' 8:25:13.882  Add        2  17 local. _remotepairing-manual-pairing._tcp. Bedroom';
      const parsed = parseBrowseLine(line);
      expect(parsed?.action).to.equal('Add');
      expect(parsed?.service.name).to.equal('Bedroom');
    });
  });

  describe('parseReachableLine', function () {
    it('extracts hostname and port from a reachable line', function () {
      const line =
        'AppleTV.local. can be reached at AppleTV.local.:49152 (interface 17)';
      expect(parseReachableLine(line)).to.deep.equal({
        hostname: 'AppleTV.local.',
        port: 49152,
      });
    });

    it('returns null when the line does not match', function () {
      expect(parseReachableLine('something unrelated')).to.be.null;
      expect(parseReachableLine('')).to.be.null;
    });

    it('returns null when the port is not a positive integer', function () {
      expect(
        parseReachableLine('AppleTV.local. can be reached at AppleTV.local.:0'),
      ).to.be.null;
    });
  });

  describe('parseTxtRecord', function () {
    it('parses key=value pairs separated by whitespace', function () {
      const line = 'identifier=ABC-123 model=AppleTV6,2 ver=17.5 protovers=1';
      expect(parseTxtRecord(line)).to.deep.equal({
        identifier: 'ABC-123',
        model: 'AppleTV6,2',
        ver: '17.5',
        protovers: '1',
      });
    });

    it('returns an empty record when no pairs are present', function () {
      expect(parseTxtRecord('no pairs here')).to.deep.equal({});
      expect(parseTxtRecord('')).to.deep.equal({});
    });

    it('does not mutate the shared regex on repeat invocations', function () {
      const line = 'a=1 b=2';
      const first = parseTxtRecord(line);
      const second = parseTxtRecord(line);
      expect(first).to.deep.equal({ a: '1', b: '2' });
      expect(second).to.deep.equal({ a: '1', b: '2' });
    });
  });
});
