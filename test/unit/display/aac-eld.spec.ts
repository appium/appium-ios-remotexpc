import {describe, it} from 'node:test';

import {expect} from 'chai';

import {
  AAC_ELD_ASC_48K_STEREO_480,
  AAC_ELD_ASC_DEVICE_ADVERTISED,
  AAC_ELD_CHANNELS,
  AAC_ELD_FORMAT,
  AAC_ELD_FRAMES_PER_PACKET,
  AAC_ELD_SAMPLE_RATE,
  aacEldDurationMs,
} from '../../../src/services/ios/display/aac-eld.js';

/** Reads an AudioSpecificConfig's leading fields. */
function parseAsc(asc: Buffer): {
  audioObjectType: number;
  samplingFrequencyIndex: number;
  channelConfiguration: number;
  frameLengthFlag: number;
} {
  const bits = [...asc].map((b) => b.toString(2).padStart(8, '0')).join('');
  let pos = 0;
  const take = (n: number): number => {
    const value = parseInt(bits.slice(pos, pos + n), 2);
    pos += n;
    return value;
  };
  let audioObjectType = take(5);
  if (audioObjectType === 31) {
    audioObjectType = 32 + take(6);
  }
  return {
    audioObjectType,
    samplingFrequencyIndex: take(4),
    channelConfiguration: take(4),
    frameLengthFlag: take(1),
  };
}

describe('AAC-ELD constants', function () {
  describe('AudioSpecificConfig', function () {
    it('describes ER AAC ELD at 48 kHz stereo', function () {
      const {audioObjectType, samplingFrequencyIndex, channelConfiguration} = parseAsc(AAC_ELD_ASC_48K_STEREO_480);

      expect(audioObjectType).to.equal(39); // ER AAC ELD
      expect(samplingFrequencyIndex).to.equal(3); // 48000 Hz
      expect(channelConfiguration).to.equal(2); // stereo
    });

    it('declares 480-sample frames, unlike the device cookie', function () {
      // frameLengthFlag 1 = 480 frames, 0 = 512. The device advertises 0, which
      // is wrong for the stream it then sends, and makes every standard decoder
      // mis-slice the access units.
      expect(parseAsc(AAC_ELD_ASC_48K_STEREO_480).frameLengthFlag).to.equal(1);
      expect(parseAsc(AAC_ELD_ASC_DEVICE_ADVERTISED).frameLengthFlag).to.equal(0);
    });

    it('differs from the device cookie in exactly that one bit', function () {
      expect(AAC_ELD_ASC_48K_STEREO_480).to.have.length(AAC_ELD_ASC_DEVICE_ADVERTISED.length);
      const differing = [...AAC_ELD_ASC_48K_STEREO_480].reduce(
        (count, byte, i) => count + (byte === AAC_ELD_ASC_DEVICE_ADVERTISED[i] ? 0 : 1),
        0,
      );
      expect(differing).to.equal(1);
      // 0x40 -> 0x50 is the frameLengthFlag bit.
      expect(AAC_ELD_ASC_48K_STEREO_480[2] ^ AAC_ELD_ASC_DEVICE_ADVERTISED[2]).to.equal(0x10);
    });
  });

  describe('AAC_ELD_FORMAT', function () {
    it('uses the corrected config, not the device cookie', function () {
      expect(AAC_ELD_FORMAT.audioSpecificConfig).to.deep.equal(AAC_ELD_ASC_48K_STEREO_480);
    });

    it('matches the individual constants', function () {
      expect(AAC_ELD_FORMAT.sampleRate).to.equal(AAC_ELD_SAMPLE_RATE).and.to.equal(48000);
      expect(AAC_ELD_FORMAT.channels).to.equal(AAC_ELD_CHANNELS).and.to.equal(2);
      expect(AAC_ELD_FORMAT.framesPerPacket).to.equal(AAC_ELD_FRAMES_PER_PACKET).and.to.equal(480);
    });
  });

  describe('aacEldDurationMs', function () {
    it('treats one access unit as 10 ms', function () {
      expect(aacEldDurationMs(1)).to.equal(10);
      expect(aacEldDurationMs(100)).to.equal(1000);
    });

    it('reproduces the duration measured on a real capture', function () {
      // 1996 access units captured in a 20 s window.
      expect(aacEldDurationMs(1996)).to.equal(19960);
    });

    it('is zero for an empty capture', function () {
      expect(aacEldDurationMs(0)).to.equal(0);
    });
  });
});
