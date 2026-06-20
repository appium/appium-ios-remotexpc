export interface PairRecord {
  publicKey: Buffer;
  privateKey: Buffer;
  remoteUnlockHostKey: string;
  remotePairingUdid?: string;
}

export interface PairingStorageInterface {
  save(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey?: string,
    remotePairingUdid?: string,
  ): Promise<string>;
  load(deviceId: string): Promise<PairRecord | null>;
  getAvailableDeviceIds(): Promise<string[]>;
}
