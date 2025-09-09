import { logger } from '@appium/support';
import { promises as fs, Stats } from 'fs';
import { createHash } from "crypto";
import path from 'path';

import type {
  MobileImageMounterService as MobileImageMounterServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import { BaseService } from '../base-service.js';
import { ServiceConnection } from '../../../service-connection.js';
import { getManifestFromTSS } from '../../../lib/tss/index.js';
import { parseXmlPlist } from '../../../lib/plist/index.js';

const log = logger.getLogger('MobileImageMounterService');

/**
 * Interface for image mount response
 */
export interface ImageMountResponse {
  Status?: string;
  Error?: string;
  DetailedError?: string;
  ImagePresent?: boolean;
  ImageSignature?: Buffer[] | Buffer;
}

/**
 * Interface for receive bytes response
 */
export interface ReceiveBytesResponse {
  Status?: string;
  Error?: string;
  DetailedError?: string;
}

/**
 * Interface for lookup image response
 */
export interface LookupImageResponse {
  ImagePresent?: boolean;
  ImageSignature?: Buffer[] | Buffer;
  Error?: string;
  DetailedError?: string;
}

/**
 * MobileImageMounterService provides an API to:
 * - Mount Developer Disk Images on iOS devices
 * - Lookup mounted images and their signatures
 * - Check if developer images are mounted
 * - Unmount images when needed
 */
class MobileImageMounterService
  extends BaseService
  implements MobileImageMounterServiceInterface
{
  static readonly RSD_SERVICE_NAME =
    'com.apple.mobile.mobile_image_mounter.shim.remote';

  // Constants
  private static readonly FILE_TYPE_IMAGE = 'image';
  private static readonly FILE_TYPE_BUILD_MANIFEST = 'build_manifest';
  private static readonly FILE_TYPE_TRUST_CACHE = 'trust_cache';
  private static readonly IMAGE_TYPE = 'Personalized';
  private static readonly MOUNT_PATH = '/System/Developer';

  // Connection cache
  private connection: ServiceConnection | null = null;

  constructor(address: [string, number]) {
    super(address);
  }

  /**
   * Clean up resources when service is no longer needed
   */
  async cleanup(): Promise<void> {
    this.closeConnection();
  }

  /**
   * Lookup for mounted images by type
   * @param imageType Type of image, 'Personalized' by default
   * @returns Promise resolving to array of signatures of mounted images
   */
  async lookup(imageType: string = MobileImageMounterService.IMAGE_TYPE): Promise<Buffer[]> {
    try {
      const request: PlistDictionary = {
        Command: 'LookupImage',
        ImageType: imageType,
      };

      const response = await this.sendRequest(request) as LookupImageResponse;
      log.debug('LookupImage response received:', response);
      this.checkIfError(response);

      const signatures = response.ImageSignature || [];

      // Handle both single signature and array of signatures
      if (Buffer.isBuffer(signatures)) {
        return [signatures];
      }

      if (Array.isArray(signatures)) {
        return signatures.filter(sig => Buffer.isBuffer(sig)) as Buffer[];
      }

      return [];
    } catch (error) {
      log.error(`Error looking up mounted images: ${error}`);
      throw error;
    }
  }

  /**
   * Check if developer image is mounted
   * @returns Promise resolving to boolean indicating if developer image is mounted
   */
  async isDeveloperImageMounted(): Promise<boolean> {
    try {
      const signatures = await this.lookup(MobileImageMounterService.IMAGE_TYPE);
      return signatures.length > 0;
    } catch (error) {
      log.debug(`Could not check if developer image is mounted: ${error}`);
      return false;
    }
  }

  /**
   * Mount personalized image for device (iOS >= 17)
   * @param imageFilePath The file path of the image (.dmg)
   * @param buildManifestFilePath The build manifest file path (.plist)
   * @param trustCacheFilePath The trust cache file path (.trustcache)
   */
  // async mount(
  //   imageFilePath: string,
  //   buildManifestFilePath: string,
  //   trustCacheFilePath: string
  // ): Promise<void> {
  //   try {
  //     // Check if image is already mounted
  //     if (await this.isDeveloperImageMounted()) {
  //       log.info('Personalized image is already mounted');
  //       return;
  //     }
  //
  //     // TODO: Check if developer mode is enabled, raise error if not
  //
  //     // Check file stats and validate files exist
  //     const [imageFileStat] = await Promise.all([
  //       this.assertIsFile(imageFilePath, MobileImageMounterService.FILE_TYPE_IMAGE),
  //       this.assertIsFile(buildManifestFilePath, MobileImageMounterService.FILE_TYPE_BUILD_MANIFEST),
  //       this.assertIsFile(trustCacheFilePath, MobileImageMounterService.FILE_TYPE_TRUST_CACHE),
  //     ]);
  //
  //     // Read files
  //     const image = await fs.readFile(imageFilePath);
  //     const trustCache = await fs.readFile(trustCacheFilePath);
  //
  //     // Get personalization manifest from device
  //     let manifest: Buffer;
  //     try {
  //       const imageHash = createHash("sha384").update(image).digest();
  //
  //       log.debug("sha384 digest of image is: " + imageHash);
  //       log.debug("sha384 hexdigest of image is: " + imageHash.toString('hex'));
  //
  //       log.debug('Attempting to query existing personalization manifest from device');
  //       manifest = await this.queryPersonalizationManifest('DeveloperDiskImage', imageHash);
  //       log.debug('Successfully retrieved personalization manifest from device');
  //     } catch (error) {
  //       if (error instanceof Error && error.message.includes('MissingManifestError')) {
  //         log.debug("Personalization manifest not found on device, falling back to TSS");
  //         log.debug("Service connection was closed by device, restarting service...");
  //
  //         try {
  //           // CRITICAL: After MissingManifestError, the service socket is closed by the device
  //           // We need to restart the service connection before proceeding with TSS
  //           await this.connectToMobileImageMounterService(); // was changed from restartServiceConnection
  //           log.debug("Service connection restarted successfully");
  //
  //           // Read build manifest
  //           const buildManifestContent = await fs.readFile(buildManifestFilePath, 'utf8');
  //           const buildManifest = parseXmlPlist(buildManifestContent) as PlistDictionary;
  //
  //           // Get device personalization identifiers to extract ECID
  //           const personalizationIdentifiers = await this.queryPersonalizationIdentifiers();
  //           log.debug('Personalization identifiers retrieved from device:', personalizationIdentifiers);
  //           const ecid = personalizationIdentifiers.UniqueChipID as number;
  //
  //           if (!ecid) {
  //             throw new Error('Could not retrieve device ECID from personalization identifiers');
  //           }
  //
  //           log.debug('Using TSS to generate personalization manifest...');
  //           manifest = await getManifestFromTSS(
  //             ecid,
  //             buildManifest,
  //             () => this.queryPersonalizationIdentifiers(),
  //             (personalizedImageType: string) => this.queryNonce(personalizedImageType)
  //           );
  //           log.debug('Successfully generated manifest from TSS');
  //         } catch (tssError) {
  //           log.error('TSS manifest generation failed:', tssError);
  //           throw new Error('Failed to generate personalization manifest via TSS: ' +
  //                          (tssError instanceof Error ? tssError.message : String(tssError)));
  //         }
  //       } else {
  //         log.debug('Failed to get manifest from device - unexpected error');
  //         throw error;
  //       }
  //     }
  //
  //     // Upload the image
  //     await this.uploadImage(MobileImageMounterService.IMAGE_TYPE, image, manifest);
  //
  //     // Mount the image with trust cache
  //     const extras = {
  //       ImageTrustCache: trustCache,
  //     };
  //
  //     await this.mountImage(MobileImageMounterService.IMAGE_TYPE, manifest, extras);
  //     log.info('Successfully mounted personalized image');
  //   } catch (error) {
  //     log.error(`Error mounting personalized image: ${error}`);
  //     throw error;
  //   }
  // }

  async mount(
    imageFilePath: string,
    buildManifestFilePath: string,
    trustCacheFilePath: string
  ): Promise<void> {
    try {
      // Check if image is already mounted
      if (await this.isDeveloperImageMounted()) {
        log.info('Personalized image is already mounted');
        return;
      }

      // TODO: Check if developer mode is enabled, raise error if not (does not affect current implementation, it is just a check

      // Check file stats and validate files exist
      const [imageFileStat] = await Promise.all([
        this.assertIsFile(imageFilePath, MobileImageMounterService.FILE_TYPE_IMAGE),
        this.assertIsFile(buildManifestFilePath, MobileImageMounterService.FILE_TYPE_BUILD_MANIFEST),
        this.assertIsFile(trustCacheFilePath, MobileImageMounterService.FILE_TYPE_TRUST_CACHE),
      ]);

      // Read files
      const image = await fs.readFile(imageFilePath);
      const trustCache = await fs.readFile(trustCacheFilePath);

      // Read build manifest
      const buildManifestContent = await fs.readFile(buildManifestFilePath, 'utf8');
      const buildManifest = parseXmlPlist(buildManifestContent) as PlistDictionary;

      // Get device personalization identifiers to extract ECID
      const personalizationIdentifiers = await this.queryPersonalizationIdentifiers();
      log.debug('Personalization identifiers retrieved from device:', personalizationIdentifiers);
      const ecid = personalizationIdentifiers.UniqueChipID as number;

      if (!ecid) {
        throw new Error('Could not retrieve device ECID from personalization identifiers');
      }

      log.debug('Using TSS to generate personalization manifest...');
      const manifest = await getManifestFromTSS(
        ecid,
        buildManifest,
        () => this.queryPersonalizationIdentifiers(),
        (personalizedImageType: string) => this.queryNonce(personalizedImageType)
      );
      log.debug('Successfully generated manifest from TSS');

      // Upload the image
      await this.uploadImage(MobileImageMounterService.IMAGE_TYPE, image, manifest);

      // Mount the image with trust cache
      const extras = {
        ImageTrustCache: trustCache,
      };

      await this.mountImage(MobileImageMounterService.IMAGE_TYPE, manifest, extras);
      log.info('Successfully mounted personalized image');
    } catch (error) {
      log.error(`Error mounting personalized image: ${error}`);
      throw error;
    }
  }

  /**
   * Unmount image from device
   * @param mountPath The mount path to unmount, defaults to '/System/Developer'
   */
  async unmountImage(mountPath: string = MobileImageMounterService.MOUNT_PATH): Promise<void> {
    try {
      const request: PlistDictionary = {
        Command: 'UnmountImage',
        MountPath: mountPath,
      };

      const response = await this.sendRequest(request) as ImageMountResponse;

      // Handle specific error cases
      if (response.Error) {
        if (response.Error === 'UnknownCommand') {
          throw new Error('Unmount command is not supported on this iOS version');
        } else if (response.DetailedError?.includes('There is no matching entry')) {
          throw new Error(`No mounted image found at path: ${mountPath}`);
        } else if (response.Error === 'InternalError') {
          throw new Error(`Internal error occurred while unmounting: ${JSON.stringify(response)}`);
        }
      }

      this.checkIfError(response);
      log.info(`Successfully unmounted image from ${mountPath}`);
    } catch (error) {
      log.error(`Error unmounting image: ${error}`);
      throw error;
    }
  }

  /**
   * Query developer mode status (iOS 16+)
   * @returns Promise resolving to boolean indicating if developer mode is enabled
   */
  async queryDeveloperModeStatus(): Promise<boolean> {
    try {
      const request: PlistDictionary = {
        Command: 'QueryDeveloperModeStatus',
      };

      const response = await this.sendRequest(request) as PlistDictionary;
      this.checkIfError(response);

      return Boolean(response.DeveloperModeStatus);
    } catch (error) {
      log.debug(`Could not query developer mode status: ${error}`);
      // Return true for older iOS versions that don't support this command
      return true;
    }
  }

  /**
   * Query personalization nonce (for personalized images)
   * @param personalizedImageType Optional personalized image type
   * @returns Promise resolving to personalization nonce
   */
  async queryNonce(personalizedImageType?: string): Promise<Buffer> {
    try {
      const request: PlistDictionary = {
        Command: 'QueryNonce',
      };

      if (personalizedImageType) {
        request.PersonalizedImageType = personalizedImageType;
      }

      const response = await this.sendRequest(request) as PlistDictionary;
      this.checkIfError(response);

      const nonce = response.PersonalizationNonce;
      if (!Buffer.isBuffer(nonce)) {
        throw new Error('Invalid nonce received from device');
      }

      return nonce;
    } catch (error) {
      log.error(`Error querying nonce: ${error}`);
      throw error;
    }
  }

  /**
   * Query personalization identifiers from the device
   * @returns Promise resolving to personalization identifiers
   */
  async queryPersonalizationIdentifiers(): Promise<PlistDictionary> {
    const request: PlistDictionary = {
      Command: 'QueryPersonalizationIdentifiers',
    };

    const response = await this.sendRequest(request) as PlistDictionary;

    this.checkIfError(response);

    return response['PersonalizationIdentifiers'] as PlistDictionary;
  }

  /**
   * Copy devices - equivalent to PyMobileDevice3's copy_devices()
   * @returns Promise resolving to the list of mounted devices
   */
  async copyDevices(): Promise<any[]> {
    try {
      const response = await this.sendRequest({ Command: 'CopyDevices' }, 10000) as any;

      if (response.EntryList) {
        return response.EntryList;
      }
      return [];
    } catch (error) {
      log.error(`Error in copyDevices: ${error}`);
      throw error;
    }
  }

  /**
   * Query personalization manifest
   * @param imageType The image type
   * @param signature The image signature/hash
   * @returns Promise resolving to personalization manifest
   */
  async queryPersonalizationManifest(imageType: string, signature: Buffer): Promise<Buffer> {
    try {
      const request = {
        Command: 'QueryPersonalizationManifest',
        PersonalizedImageType: imageType,
        ImageType: imageType,
        ImageSignature: signature,
      };

      const response = await this.sendRequest(request, 10000) as PlistDictionary;

      this.checkIfError(response);

      // The response "ImageSignature" is an IM4M manifest
      const manifest = response.ImageSignature;

      if (!manifest) {
        throw new Error('MissingManifestError: Personalization manifest not found on device');
      }

      if (!Buffer.isBuffer(manifest)) {
        throw new Error('Invalid manifest received from device');
      }

      return manifest;
    } catch (error) {
      if (error instanceof Error && error.message.includes('MissingManifestError')) {
        throw error;
      }
      throw new Error('MissingManifestError: Personalization manifest not found on device');
    }
  }

  /**
   * Upload image to device
   * @param imageType The image type
   * @param image The image data
   * @param signature The image signature/manifest
   */
  async uploadImage(imageType: string, image: Buffer, signature: Buffer): Promise<void> {
    try {
      // Step 1: Send ReceiveBytes command
      const receiveBytesResult = await this.sendRequest({
        Command: 'ReceiveBytes',
        ImageType: imageType,
        ImageSize: image.length,
        ImageSignature: signature,
      }) as ReceiveBytesResponse;

      this.checkIfError(receiveBytesResult);

      if (receiveBytesResult.Status !== 'ReceiveBytesAck') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on sending ReceiveBytes: ${JSON.stringify(receiveBytesResult)}`
        );
      }

      // Step 2: Send image data (force new connection for upload)
      const conn = await this.connectToMobileImageMounterService(true);
      const socket = conn.getSocket();
      
      await new Promise<void>((resolve, reject) => {
        socket.write(image, (error: Error | null | undefined) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      // Step 3: Wait for upload completion
      const uploadResult = await conn.receive();
      if (uploadResult.Status !== 'Complete') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on pushing image file: ${JSON.stringify(uploadResult)}`
        );
      }

      log.debug('Image uploaded successfully');
    } catch (error) {
      log.error(`Error uploading image: ${error}`);
      throw error;
    }
  }

  /**
   * Mount image on device
   * @param imageType The image type
   * @param signature The image signature/manifest
   * @param extras Additional parameters for mounting
   */
  async mountImage(imageType: string, signature: Buffer, extras?: Record<string, any>): Promise<void> {
    try {
      const request: PlistDictionary = {
        Command: 'MountImage',
        ImageType: imageType,
        ImageSignature: signature,
      };

      if (extras) {
        Object.assign(request, extras);
      }

      const response = await this.sendRequest(request) as ImageMountResponse;

      // Handle case where image is already mounted
      if (response.DetailedError?.includes('is already mounted')) {
        log.info('Image was already mounted');
        return;
      }

      // Check for developer mode errors
      if (response.DetailedError?.includes('Developer mode is not enabled')) {
        throw new Error('Developer mode is not enabled on this device');
      }

      this.checkIfError(response);

      if (response.Status !== 'Complete') {
        throw new Error(`Mount image failed: ${JSON.stringify(response)}`);
      }

      log.debug('Image mounted successfully');
    } catch (error) {
      log.error(`Error mounting image: ${error}`);
      throw error;
    }
  }

  // Private helper methods

  /**
   * Send a request to the mobile image mounter service
   * @param request The plist request to send
   * @param timeout Optional timeout in milliseconds
   * @returns Promise resolving to the response
   */
  private async sendRequest(
    request: PlistDictionary,
    timeout?: number
  ): Promise<PlistDictionary> {
    // Add detailed debug logging for the exact plist being sent
    // log.debug("=== EXACT PLIST REQUEST DEBUG ===");
    // log.debug("Request object before plist conversion:", request);

    // Send the request and get the first response (usually StartService)
    // log.debug("=== SENDING PLIST REQUEST ===");
    // log.debug("About to call conn.sendPlistRequest()...");

    // Check if we're creating a new connection or reusing an existing one
    const isNewConnection = !this.connection || (() => {
      try {
        const socket = this.connection!.getSocket();
        return !socket || socket.destroyed;
      } catch {
        return true;
      }
    })();

    log.debug(`Connection status: ${isNewConnection ? 'NEW CONNECTION' : 'REUSING EXISTING CONNECTION'}`);

    // Let's also hook into the connection to see what's being sent
    const conn = await this.connectToMobileImageMounterService();

    // Debug the connection object
    // log.debug("Connection created:", typeof conn);
    // log.debug("Connection methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(conn)));

    // Try to access the underlying socket if possible to log what's sent
    // const socket = (conn as any).getSocket?.() || (conn as any).socket;
    // if (socket) {
    //   log.debug("Socket found:", typeof socket);
    //
    //   // Hook into the socket write method to log what's being sent
    //   const originalWrite = socket.write;
    //   socket.write = function(data: any, ...args: any[]) {
    //     log.debug("=== SOCKET WRITE DEBUG ===");
    //     log.debug("Data type:", typeof data);
    //     log.debug("full data navin:", data.toString("hex").match(/.{1,2}/g).join(" "));
    //
    //     log.debug("Data length:", data?.length || 'unknown');
    //
    //     if (Buffer.isBuffer(data)) {
    //       log.debug("Buffer data (first 100 bytes):", data.subarray(0, Math.min(100, data.length)).toString('hex'));
    //       log.debug("Buffer data as string (first 500 chars):", data.subarray(0, Math.min(500, data.length)).toString());
    //
    //       // Show the length prefix (first 4 bytes)
    //       if (data.length >= 4) {
    //         const lengthPrefix = data.readUInt32BE(0);
    //         log.debug("Length prefix (first 4 bytes as uint32BE):", lengthPrefix);
    //         log.debug("Length prefix hex:", data.subarray(0, 4).toString('hex'));
    //
    //         // Show the payload after length prefix
    //         log.debug("Payload after length prefix:", data.subarray(4).toString());
    //       }
    //     } else if (typeof data === 'string') {
    //       log.debug("String data:", data.substring(0, 500));
    //     }
    //     log.debug("=== END SOCKET WRITE DEBUG ===");
    //
    //     return originalWrite.call(this, data, ...args);
    //   };
    // }

    const res = await conn.sendPlistRequest(request, timeout);
    // log.debug("=== FIRST RESPONSE RECEIVED ===");
    // log.debug("res from first send and receive: ", res);
    // log.debug("res type:", typeof res);
    // log.debug("res constructor:", res?.constructor?.name);

    // Check if this is a StartService response (new connection) or actual response (reused connection)
    if (isNewConnection && res && typeof res === 'object' && res.Request === 'StartService') {
      // New connection: we got StartService response, need to wait for actual response
      // log.debug("=== WAITING FOR SECOND RESPONSE (new connection) ===");
      // log.debug("About to call conn.receive() for actual command response...");
      const startTime = Date.now();

      try {
        const response = await conn.receive();
        const endTime = Date.now();
        // log.debug("=== SECOND RESPONSE RECEIVED ===");
        // log.debug(`Received response after ${endTime - startTime}ms`);
        // log.debug(`${request.Command} response received from sendRequest`, response);
        // log.debug("response type:", typeof response);
        // log.debug("response constructor:", response?.constructor?.name);

        if (!response) {
          return {};
        }

        if (Array.isArray(response)) {
          return response.length > 0 ? (response[0] as PlistDictionary) : {};
        }

        return response as PlistDictionary;
      } catch (receiveError) {
        const endTime = Date.now();
        log.error("=== ERROR RECEIVING SECOND RESPONSE ===");
        log.error(`Error after ${endTime - startTime}ms:`, receiveError);
        throw receiveError;
      }
    } else {
      // Reused connection: we already got the actual response
      log.debug("=== REUSED CONNECTION - Response is the actual command response ===");
      log.debug(`${request.Command} response received from sendRequest`, res);
      
      if (!res) {
        return {};
      }

      if (Array.isArray(res)) {
        return res.length > 0 ? (res[0] as PlistDictionary) : {};
      }

      return res as PlistDictionary;
    }
  }

  /**
   * Connect to the mobile image mounter service
   * @param forceNew Force creation of a new connection (used for upload operations)
   * @returns Promise resolving to a service connection
   */
  private async connectToMobileImageMounterService(forceNew = false): Promise<ServiceConnection> {
    // Return existing connection if available and not forcing new
    if (!forceNew && this.connection) {
      try {
        // Check if connection is still alive by accessing the socket
        const socket = this.connection.getSocket();
        if (socket && !socket.destroyed) {
          log.debug('Reusing existing connection');
          return this.connection;
        }
      } catch (error) {
        log.debug('Existing connection is no longer valid, creating new one');
        this.connection = null;
      }
    }

    // Create new connection
    const service = {
      serviceName: MobileImageMounterService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    const newConnection = await this.startLockdownService(service);
    
    // Only cache connection if not forced new
    if (!forceNew) {
      this.connection = newConnection;
    }
    
    return newConnection;
  }

  /**
   * Close the current connection
   */
  private closeConnection(): void {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (error) {
        log.debug('Error closing connection:', error);
      }
      this.connection = null;
    }
  }

  /**
   * Restart service connection after it was closed by the device
   * This is required after MissingManifestError as the device closes the socket
   * @returns Promise that resolves when connection is ready
   */
  private async restartServiceConnection(): Promise<void> {
    log.debug('Restarting service connection...');
    
    // Close existing connection if any
    this.closeConnection();
    
    // Create a new connection to verify connectivity
    const conn = await this.connectToMobileImageMounterService(true);
    log.debug('Service connection restarted successfully');
  }

  /**
   * Check if the response contains an error and throw if it does
   * @param response The response to check
   */
  private checkIfError(response: any): void {
    if (response.Error) {
      throw new Error(response.Error);
    }
  }

  /**
   * Assert that a file path exists and is a file (not a directory)
   * @param filePath The file path to check
   * @param fileType The type of file for error messages
   * @returns Promise resolving to file stats
   */
  private async assertIsFile(filePath: string, fileType: string): Promise<Stats> {
    try {
      const fileStat = await fs.stat(filePath);

      if (fileStat.isDirectory()) {
        throw new Error(
          `The provided ${fileType} path is expected to be a file, but a directory was given: ${filePath}`
        );
      }

      return fileStat;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`The provided ${fileType} path does not exist: ${filePath}`);
      }
      throw error;
    }
  }

}

export default MobileImageMounterService;
export { MobileImageMounterService };
