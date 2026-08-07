const MISSING_UDID_MESSAGE = 'set UDID env var to execute tests.';

export function requireDeviceUdid(message = MISSING_UDID_MESSAGE): string {
  const udid = process.env.UDID?.trim() ?? '';
  if (!udid) {
    throw new Error(message);
  }
  return udid;
}
