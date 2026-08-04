import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

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

      assert.strictEqual(audioObjectType, 39); // ER AAC ELD
      assert.strictEqual(samplingFrequencyIndex, 3); // 48000 Hz
      assert.strictEqual(channelConfiguration, 2); // stereo
    });

    it('declares 480-sample frames, unlike the device cookie', function () {
      // frameLengthFlag 1 = 480 frames, 0 = 512. The device advertises 0, which
      // is wrong for the stream it then sends, and makes every standard decoder
      // mis-slice the access units.
      assert.strictEqual(parseAsc(AAC_ELD_ASC_48K_STEREO_480).frameLengthFlag, 1);
      assert.strictEqual(parseAsc(AAC_ELD_ASC_DEVICE_ADVERTISED).frameLengthFlag, 0);
    });

    it('differs from the device cookie in exactly that one bit', function () {
      assert.strictEqual(AAC_ELD_ASC_48K_STEREO_480.length, AAC_ELD_ASC_DEVICE_ADVERTISED.length);
      const differing = [...AAC_ELD_ASC_48K_STEREO_480].reduce(
        (count, byte, i) => count + (byte === AAC_ELD_ASC_DEVICE_ADVERTISED[i] ? 0 : 1),
        0,
      );
      assert.strictEqual(differing, 1);
      // 0x40 -> 0x50 is the frameLengthFlag bit.
      assert.strictEqual(AAC_ELD_ASC_48K_STEREO_480[2] ^ AAC_ELD_ASC_DEVICE_ADVERTISED[2], 0x10);
    });
  });

  describe('AAC_ELD_FORMAT', function () {
    it('uses the corrected config, not the device cookie', function () {
      assert.deepStrictEqual(AAC_ELD_FORMAT.audioSpecificConfig, AAC_ELD_ASC_48K_STEREO_480);
    });

    it('matches the individual constants', function () {
      assert.strictEqual(AAC_ELD_FORMAT.sampleRate, AAC_ELD_SAMPLE_RATE);
      assert.strictEqual(AAC_ELD_FORMAT.sampleRate, 48000);
      assert.strictEqual(AAC_ELD_FORMAT.channels, AAC_ELD_CHANNELS);
      assert.strictEqual(AAC_ELD_FORMAT.channels, 2);
      assert.strictEqual(AAC_ELD_FORMAT.framesPerPacket, AAC_ELD_FRAMES_PER_PACKET);
      assert.strictEqual(AAC_ELD_FORMAT.framesPerPacket, 480);
    });
  });

  describe('aacEldDurationMs', function () {
    it('treats one access unit as 10 ms', function () {
      assert.strictEqual(aacEldDurationMs(1), 10);
      assert.strictEqual(aacEldDurationMs(100), 1000);
    });

    it('reproduces the duration measured on a real capture', function () {
      // 1996 access units captured in a 20 s window.
      assert.strictEqual(aacEldDurationMs(1996), 19960);
    });

    it('is zero for an empty capture', function () {
      assert.strictEqual(aacEldDurationMs(0), 0);
    });
  });
});
