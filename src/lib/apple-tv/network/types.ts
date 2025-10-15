/** Interface for network communication with Apple TV devices */
export interface NetworkClientInterface {
  connect(ip: string, port: number): Promise<void>;
  sendPacket(data: any): Promise<void>;
  receiveResponse(): Promise<any>;
  disconnect(): void;
}
