const MISSING_UDID_MESSAGE = 'set UDID env var to execute tests.';

export function requireDeviceUdid(message = MISSING_UDID_MESSAGE): string {
  const udid = process.env.UDID?.trim() ?? '00008030-001E290A3EF2402E';
  if (!udid) {
    throw new Error(message);
  }
  return udid;
}
