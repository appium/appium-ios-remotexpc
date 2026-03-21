import { expect } from 'chai';

import {
  PairingError,
  UserDeniedPairingError,
} from '../../../src/lib/remote-pairing/errors.js';
import { resolvePairingDataFieldAfterM1 } from '../../../src/lib/remote-pairing/pairing-protocol/pairing-consent.js';
import { isAppleTvModel } from '../../../src/lib/remote-pairing/pairing-protocol/pairing-protocol.js';

describe('Remote pairing helpers', function () {
  describe('isAppleTvModel', function () {
    it('detects tvOS Apple TV model strings', function () {
      expect(isAppleTvModel('AppleTV11,1')).to.equal(true);
      expect(isAppleTvModel('AppleTV14,1')).to.equal(true);
    });

    it('returns false for iPhone / iPad', function () {
      expect(isAppleTvModel('iPhone15,2')).to.equal(false);
      expect(isAppleTvModel('iPad14,1')).to.equal(false);
    });

    it('returns false for empty / undefined', function () {
      expect(isAppleTvModel('')).to.equal(false);
      expect(isAppleTvModel(undefined)).to.equal(false);
    });
  });

  describe('resolvePairingDataFieldAfterM1', function () {
    it('returns immediate pairingData (tvOS-style)', async function () {
      const tlv = Buffer.from('test').toString('base64');
      const first = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  pairingData: { _0: { data: tlv } },
                },
              },
            },
          },
        },
      };
      const data = await resolvePairingDataFieldAfterM1(first, async () => {
        throw new Error('should not wait for second message');
      });
      expect(data).to.equal(tlv);
    });

    it('reads second message when awaitingUserConsent (iOS-style)', async function () {
      const tlv = Buffer.from('srp').toString('base64');
      const first = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  awaitingUserConsent: {},
                },
              },
            },
          },
        },
      };
      const second = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  pairingData: { _0: { data: tlv } },
                },
              },
            },
          },
        },
      };
      let calls = 0;
      const data = await resolvePairingDataFieldAfterM1(first, async () => {
        calls++;
        return second;
      });
      expect(calls).to.equal(1);
      expect(data).to.equal(tlv);
    });

    it('throws PairingError on pairingRejectedWithError', async function () {
      const first = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  pairingRejectedWithError: {
                    wrappedError: {
                      userInfo: {
                        NSLocalizedDescription: 'no',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
      try {
        await resolvePairingDataFieldAfterM1(first, async () => ({}));
        expect.fail('expected throw');
      } catch (e) {
        expect(e).to.be.instanceOf(PairingError);
        expect((e as PairingError).code).to.equal('PAIRING_REJECTED');
      }
    });

    it('throws UserDeniedPairingError when consent then rejected', async function () {
      const first = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  awaitingUserConsent: {},
                },
              },
            },
          },
        },
      };
      const second = {
        message: {
          plain: {
            _0: {
              event: {
                _0: {
                  pairingRejectedWithError: {
                    wrappedError: {
                      userInfo: {
                        NSLocalizedDescription: 'denied',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };
      try {
        await resolvePairingDataFieldAfterM1(first, async () => second);
        expect.fail('expected throw');
      } catch (e) {
        expect(e).to.be.instanceOf(UserDeniedPairingError);
      }
    });
  });
});
