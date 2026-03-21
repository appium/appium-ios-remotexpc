/**
 * Apple TV–specific discovery filter ({@link toAppleTVDevices}) and legacy type aliases.
 *
 * Generic Wi‑Fi Remote Pairing lives in {@link ../remote-pairing/index.js}.
 *
 * @module
 */

export { toAppleTVDevices } from './mapper.js';

export type {
  RemotePairingDevice as AppleTVDevice,
  RemotePairingResult as AppleTVPairingResult,
  RemotePairingDeviceInfo as AppleTVDeviceInfo,
} from '../remote-pairing/types.js';

export {
  RemotePairingTunnelService as AppleTVTunnelService,
  TunnelService,
} from '../remote-pairing/tunnel/index.js';

export {
  RemotePairingService,
  RemotePairingService as AppleTVPairingService,
  UserInputService,
} from '../remote-pairing/pairing/index.js';

export {
  RemotePairingError as AppleTVError,
  PairingError,
  NetworkError,
  CryptographyError,
  SRPError,
  TLV8Error,
  UserDeniedPairingError,
  RemotePairingCompletedError,
  RemotePairingError,
} from '../remote-pairing/errors.js';
