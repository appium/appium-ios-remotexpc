import { PairingError, UserDeniedPairingError } from '../errors.js';

export function getPlainEventZero(response: any): any {
  return response?.message?.plain?._0?.event?._0;
}

/**
 * M1 response handling: immediate pairingData, `awaitingUserConsent`, or rejection
 * (pymobiledevice3 `_request_pair_consent`).
 */
export async function resolvePairingDataFieldAfterM1(
  firstResponse: any,
  receiveNext: () => Promise<any>,
): Promise<string | Buffer> {
  let event = getPlainEventZero(firstResponse);

  if (event?.pairingRejectedWithError) {
    const desc =
      event.pairingRejectedWithError?.wrappedError?.userInfo
        ?.NSLocalizedDescription ?? 'Pairing rejected';
    throw new PairingError(String(desc), 'PAIRING_REJECTED', event);
  }

  if (event?.awaitingUserConsent) {
    const next = await receiveNext();
    event = getPlainEventZero(next);
  }

  if (event?.pairingRejectedWithError) {
    const desc =
      event.pairingRejectedWithError?.wrappedError?.userInfo
        ?.NSLocalizedDescription ?? 'Pairing rejected';
    throw new UserDeniedPairingError(
      String(desc),
      event.pairingRejectedWithError,
    );
  }

  const rawData = event?.pairingData?._0?.data;
  if (rawData == null) {
    throw new PairingError('No pairing data received', 'NO_PAIRING_DATA');
  }

  return rawData;
}
