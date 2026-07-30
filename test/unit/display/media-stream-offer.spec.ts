import {describe, it} from 'node:test';
import {inflateSync} from 'node:zlib';

import {expect} from 'chai';

import {parseBinaryPlist} from '../../../src/lib/plist/binary-plist-parser.js';
import {
  buildMediaBlobAudio,
  buildMediaBlobVideo,
  buildNegotiatorOfferAudio,
  buildNegotiatorOfferVideo,
  buildRemoteEndpointInfo,
  newCallId,
  newSessionId,
} from '../../../src/services/ios/display/media-stream-offer.js';

/**
 * Templates captured from a real Xcode screen-mirroring offer. These are the
 * ground truth for the whole negotiation: the mediaBlob is a hand-rolled
 * protobuf, so byte-equivalence with Apple's own encoder is what proves the
 * builders correct.
 */
const CAPTURED_VIDEO_TEMPLATE =
  '080110012a7f088182bae90810001a3f087b120a0801100118c387032000120a' +
  '0801100218c387032000120a0801100118c387032000120a0801100218c38703' +
  '20001a09464c533b53573a313b20011a2e0864120a0801100118c38703200012' +
  '0a0801100218c3870320001a10464c533b565241453a303b53573a313b200e38' +
  '01403f6001320d56696365726f7920312e372e3040004a0908ea1f1000188080' +
  '014a0b080010c0d1e123188080204a0a08001080b489131880604a0508101084' +
  '204a0b08001080dac409188080064a05080410e4324a0b080010809bee021880' +
  '80084a0b08001080c2d72f188080404a0b080010808ece1c188080104a050801' +
  '10ab026880c0dd87d2a0c0e9ed017002800100900101';
const CAPTURED_VIDEO_SESSION_ID = 2368635137;

const CAPTURED_AUDIO_TEMPLATE =
  '080110011a1208b4a1a5f70a1000180020ffbc0128003000320d56696365726f79' +
  '20312e372e3040004a0908ea1f1000188080014a05080110ab024a0b080010808e' +
  'ce1c188080104a05080410e4324a0b08001080dac409188080064a0b08001080c2' +
  'd72f188080404a0a08001080b489131880604a0b080010809bee02188080084a05' +
  '08101084204a0b080010c0d1e12318808020688080d2b28ebbdfe9ed0170028001' +
  '00900101';
const CAPTURED_AUDIO_SESSION_ID = 2934526132;

describe('media stream offer', function () {
  describe('mediaBlob byte-equivalence with Apple captures', function () {
    it('reproduces the captured video mediaBlob exactly', function () {
      // The capture was taken with LTRP on and FEC off; both defaults have since
      // been flipped, so they are restored here to compare like for like.
      const blob = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {
        ltrpEnabled: true,
        fecEnabled: false,
      });

      expect(blob.toString('hex')).to.equal(CAPTURED_VIDEO_TEMPLATE);
    });

    it('reproduces the captured audio mediaBlob exactly', function () {
      const blob = buildMediaBlobAudio(CAPTURED_AUDIO_SESSION_ID);

      expect(blob.toString('hex')).to.equal(CAPTURED_AUDIO_TEMPLATE);
    });

    it('encodes the session id as a fixed-width 5-byte varint', function () {
      // Apple pads the session-id slot so the encoder can rewrite it in place.
      // A small id must therefore still occupy 5 bytes, via redundant
      // continuation bytes, rather than collapsing to one.
      const small = buildMediaBlobVideo(1, {ltrpEnabled: true, fecEnabled: false});
      const large = buildMediaBlobVideo(0xffff_ffff, {ltrpEnabled: true, fecEnabled: false});

      expect(small.length).to.equal(large.length);
      expect(small.length).to.equal(CAPTURED_VIDEO_TEMPLATE.length / 2);
      // Layout: 0801 (f1=1) 1001 (f2=1) 2a7f (f5, length 127), then the
      // VideoSettings body opens with field 1 (0x08) and exactly five bytes.
      expect(small.subarray(6, 12).toString('hex')).to.equal('088180808000');
    });
  });

  describe('mediaBlob options', function () {
    it('omits the FEC field when disabled and includes it when enabled', function () {
      const withoutFec = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {fecEnabled: false});
      const withFec = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {fecEnabled: true});

      // The FEC field adds 2 bytes to VideoSettings, which pushes its length
      // varint from one byte to two — hence 3, not 2, at the top level.
      expect(withFec.length).to.equal(withoutFec.length + 3);
      // Disabling it is exactly what reproduces Apple's capture.
      expect(withoutFec.toString('hex')).to.contain('2a7f');
    });

    it('omits tilesPerFrame at the default of 1', function () {
      const defaulted = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {tilesPerFrame: 1});
      const explicit = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {tilesPerFrame: 4});

      expect(explicit.length).to.be.greaterThan(defaulted.length);
    });

    it('defaults to LTRP off and FEC on', function () {
      const defaulted = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID);
      const explicit = buildMediaBlobVideo(CAPTURED_VIDEO_SESSION_ID, {
        ltrpEnabled: false,
        fecEnabled: true,
      });

      expect(defaulted.toString('hex')).to.equal(explicit.toString('hex'));
    });
  });

  describe('buildRemoteEndpointInfo', function () {
    it('encodes the host identity as the captured protobuf', function () {
      const info = buildRemoteEndpointInfo({model: 'Mac15,9', osVersion: '2205.3.1', build: '25F80'});

      expect(info.toString('hex')).to.equal(
        '08001001' + // field1 = 0, field2 = 1
          '1a074d616331352c39' + // model "Mac15,9"
          '2208323230352e332e31' + // osVersion "2205.3.1"
          '2a053235463830', // build "25F80"
      );
    });

    it('defaults to the identity Xcode reports', function () {
      expect(buildRemoteEndpointInfo().toString('hex')).to.equal(
        buildRemoteEndpointInfo({model: 'Mac15,9', osVersion: '2205.3.1', build: '25F80'}).toString('hex'),
      );
    });
  });

  describe('negotiator offer plist', function () {
    const callId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

    it('wraps the video mediaBlob in the four-key offer', function () {
      const offer = buildNegotiatorOfferVideo(callId, CAPTURED_VIDEO_SESSION_ID, {
        ltrpEnabled: true,
        fecEnabled: false,
      });
      const parsed = parseBinaryPlist(offer) as Record<string, unknown>;

      expect(Object.keys(parsed).sort()).to.deep.equal([
        'avcMediaStreamNegotiatorMediaBlob',
        'avcMediaStreamNegotiatorMode',
        'avcMediaStreamOptionCallID',
        'avcMediaStreamOptionRemoteEndpointInfo',
      ]);
      expect(parsed.avcMediaStreamNegotiatorMode).to.equal(5);
      expect(parsed.avcMediaStreamOptionCallID).to.equal(callId);
      // The blob travels compressed; it must inflate back to the exact capture.
      const blob = inflateSync(parsed.avcMediaStreamNegotiatorMediaBlob as Buffer);
      expect(blob.toString('hex')).to.equal(CAPTURED_VIDEO_TEMPLATE);
    });

    it('uses negotiator mode 6 for audio', function () {
      const offer = buildNegotiatorOfferAudio(callId, CAPTURED_AUDIO_SESSION_ID);
      const parsed = parseBinaryPlist(offer) as Record<string, unknown>;

      expect(parsed.avcMediaStreamNegotiatorMode).to.equal(6);
      const blob = inflateSync(parsed.avcMediaStreamNegotiatorMediaBlob as Buffer);
      expect(blob.toString('hex')).to.equal(CAPTURED_AUDIO_TEMPLATE);
    });

    it('compresses the blob at level 9, as Apple does', function () {
      const offer = buildNegotiatorOfferVideo(callId, CAPTURED_VIDEO_SESSION_ID);
      const parsed = parseBinaryPlist(offer) as Record<string, unknown>;
      const compressed = parsed.avcMediaStreamNegotiatorMediaBlob as Buffer;

      // zlib header: 0x78 0xDA marks a level-9 ("best compression") stream.
      expect(compressed.subarray(0, 2).toString('hex')).to.equal('78da');
    });

    it('threads a custom host identity into the offer', function () {
      const offer = buildNegotiatorOfferVideo(callId, CAPTURED_VIDEO_SESSION_ID, {
        hostIdentity: {model: 'Mac16,11'},
      });
      const parsed = parseBinaryPlist(offer) as Record<string, unknown>;

      expect((parsed.avcMediaStreamOptionRemoteEndpointInfo as Buffer).toString('hex')).to.equal(
        buildRemoteEndpointInfo({model: 'Mac16,11'}).toString('hex'),
      );
    });
  });

  describe('identifier generators', function () {
    it('generates upper-case UUID call ids', function () {
      const callId = newCallId();

      expect(callId).to.match(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    });

    it('generates session ids inside the uint32 range', function () {
      for (let i = 0; i < 100; i++) {
        const sessionId = newSessionId();
        expect(sessionId).to.be.at.least(0);
        expect(sessionId).to.be.below(0x1_0000_0000);
        expect(Number.isInteger(sessionId)).to.equal(true);
      }
    });
  });
});
