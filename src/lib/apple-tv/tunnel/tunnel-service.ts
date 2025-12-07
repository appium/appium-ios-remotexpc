import * as tls from 'node:tls';

import { getLogger } from '../../logger.js';
import {
  decryptChaCha20Poly1305,
  encryptChaCha20Poly1305,
} from '../encryption/index.js';
import { PairingError } from '../errors.js';
import type { NetworkClientInterface } from '../network/types.js';
import type { VerificationKeys } from '../pairing-protocol/pair-verification-protocol.js';
import type { TcpListenerInfo, TlsPskConnectionOptions } from './types.js';

export class TunnelService {
  private static readonly log = getLogger('TunnelService');
  private encryptedSequenceNumber = 0;

  constructor(
    private readonly networkClient: NetworkClientInterface,
    private readonly keys: VerificationKeys,
    private sequenceNumber: number,
  ) {}

  async createTcpListener(): Promise<TcpListenerInfo> {
    TunnelService.log.debug('Creating TCP listener (Encrypted Request)');

    const request = {
      request: {
        _0: {
          createListener: {
            key: this.keys.encryptionKey.toString('base64'),
            peerConnectionsInfo: [
              {
                owningPID: process.pid,
                owningProcessName: 'CoreDeviceService',
              },
            ],
            transportProtocolType: 'tcp',
          },
        },
      },
    };

    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber), 0);

    const requestJson = JSON.stringify(request);

    const encrypted = encryptChaCha20Poly1305({
      plaintext: Buffer.from(requestJson, 'utf8'),
      key: this.keys.clientEncryptionKey,
      nonce,
    });

    const encryptedPayload = {
      message: {
        streamEncrypted: {
          _0: encrypted.toString('base64'),
        },
      },
      originatedBy: 'host',
      sequenceNumber: this.sequenceNumber++,
    };

    await this.networkClient.sendPacket(encryptedPayload);
    this.encryptedSequenceNumber++;

    const response = await this.networkClient.receiveResponse();

    const encryptedData = response.message?.streamEncrypted?._0;

    if (!encryptedData) {
      throw new PairingError(
        'No encrypted response received',
        'NO_ENCRYPTED_RESPONSE',
      );
    }

    const responseNonce = Buffer.alloc(12);
    responseNonce.writeBigUInt64LE(BigInt(this.encryptedSequenceNumber - 1), 0);

    const decrypted = decryptChaCha20Poly1305({
      ciphertext: Buffer.from(encryptedData, 'base64'),
      key: this.keys.serverEncryptionKey,
      nonce: responseNonce,
    });

    const responseJson = JSON.parse(decrypted.toString('utf8'));
    const createListenerResponse = responseJson?.response?._1?.createListener;

    if (!createListenerResponse?.port) {
      TunnelService.log.error('Invalid createListener response:', responseJson);
      throw new PairingError(
        'No port in createListener response',
        'NO_LISTENER_PORT',
      );
    }

    TunnelService.log.debug(
      `TCP Listener created on port: ${createListenerResponse.port}`,
    );

    return createListenerResponse;
  }

  async createTlsPskConnection(
    hostname: string,
    port: number,
  ): Promise<tls.TLSSocket> {
    TunnelService.log.debug(
      `Creating TLS-PSK connection to ${hostname}:${port}`,
    );

    return new Promise((resolve, reject) => {
      const options: TlsPskConnectionOptions = {
        host: hostname,
        port,
        pskCallback: (hint: string | null) => {
          TunnelService.log.debug(`PSK callback invoked with hint: ${hint}`);
          return {
            psk: this.keys.encryptionKey,
            identity: '',
          };
        },
        ciphers:
          'PSK-AES256-CBC-SHA:PSK-AES128-CBC-SHA:PSK-3DES-EDE-CBC-SHA:PSK-RC4-SHA:PSK',
        secureProtocol: 'TLSv1_2_method',
        // SECURITY NOTE: Disabling certificate validation is intentional and safe in this context.
        // This connection uses TLS-PSK (Pre-Shared Key) authentication, where the pre-shared key
        // itself provides mutual authentication between client and server. Traditional X.509
        // certificate validation is not used in PSK-based TLS connections. The encryption key
        // was securely established during the pairing process (which involves PIN verification),
        // and this key authenticates both parties. This is the standard approach for Apple TV's
        // RemoteXPC protocol and should NOT be changed to use certificate validation.
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      };

      const socket = tls.connect(options, () => {
        TunnelService.log.debug('TLS-PSK connection established');
        resolve(socket);
      });

      socket.on('error', (error: Error & { code?: string }) => {
        TunnelService.log.error('TLS-PSK connection error:', error);

        if (
          error.message?.includes('no shared cipher') ||
          error.code === 'ECONNRESET'
        ) {
          TunnelService.log.error(
            'PSK ciphers may not be available in your Node.js build',
          );
          TunnelService.log.error('You may need to:');
          TunnelService.log.error(
            '1. Use Node.js compiled with PSK-enabled OpenSSL',
          );
          TunnelService.log.error(
            '2. Use a Python subprocess for the TLS-PSK connection',
          );
          TunnelService.log.error('3. Use a native module like node-openssl');
        }

        reject(error);
      });

      socket.on('secureConnect', () => {
        TunnelService.log.debug('Secure connection event fired');
      });

      socket.on('tlsClientError', (error) => {
        TunnelService.log.error('TLS client error:', error);
      });
    });
  }

  getSequenceNumber(): number {
    return this.sequenceNumber;
  }
}
