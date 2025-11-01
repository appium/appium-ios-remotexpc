/** Interface for storing pairing credentials to disk */
export interface PairingStorageInterface {
  save(
    deviceId: string,
    ltpk: Buffer,
    ltsk: Buffer,
    remoteUnlockHostKey?: string,
  ): Promise<string>;
}
