/** TCP transport for Remote Pairing (RPPairing) messages */
export interface NetworkClientInterface {
  connect(ip: string, port: number): Promise<void>;
  sendPacket(data: any): Promise<void>;
  receiveResponse(): Promise<any>;
  disconnect(): void;
}
