import { logger } from '@appium/support';
import { createHash } from 'crypto';
import { Stats, promises as fs } from 'fs';

import { parseXmlPlist } from '../../../lib/plist/index.js';
import { getManifestFromTSS } from '../../../lib/tss/index.js';
import type {
  MobileImageMounterService as MobileImageMounterServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
import { ServiceConnection } from '../../../service-connection.js';
import { BaseService } from '../base-service.js';

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
  async lookup(
    imageType: string = MobileImageMounterService.IMAGE_TYPE,
  ): Promise<Buffer[]> {
    try {
      const request: PlistDictionary = {
        Command: 'LookupImage',
        ImageType: imageType,
      };

      const response = (await this.sendRequest(request)) as LookupImageResponse;
      this.checkIfError(response);

      const signatures = response.ImageSignature || [];

      // Handle both single signature and array of signatures
      if (Buffer.isBuffer(signatures)) {
        return [signatures];
      }

      if (Array.isArray(signatures)) {
        return signatures.filter((sig) => Buffer.isBuffer(sig)) as Buffer[];
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
      const signatures = await this.lookup(
        MobileImageMounterService.IMAGE_TYPE,
      );
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
  async mount(
    imageFilePath: string,
    buildManifestFilePath: string,
    trustCacheFilePath: string,
  ): Promise<void> {
    try {
      // Check if image is already mounted
      if (await this.isDeveloperImageMounted()) {
        log.info('Personalized image is already mounted');
        return;
      }

      const [imageFileStat] = await Promise.all([
        this.assertIsFile(
          imageFilePath,
          MobileImageMounterService.FILE_TYPE_IMAGE,
        ),
        this.assertIsFile(
          buildManifestFilePath,
          MobileImageMounterService.FILE_TYPE_BUILD_MANIFEST,
        ),
        this.assertIsFile(
          trustCacheFilePath,
          MobileImageMounterService.FILE_TYPE_TRUST_CACHE,
        ),
      ]);

      const image = await fs.readFile(imageFilePath);
      const trustCache = await fs.readFile(trustCacheFilePath);

      const buildManifestContent = await fs.readFile(
        buildManifestFilePath,
        'utf8',
      );
      const buildManifest = parseXmlPlist(
        buildManifestContent,
      ) as PlistDictionary;

      // Try to fetch the personalization manifest if the device already has one
      // In case of failure, the service will close the socket, so we'll have to re-establish the connection
      // and query the manifest from Apple's ticket server (TSS) instead
      let manifest: Buffer;
      try {
        const imageHash = createHash('sha384').update(image).digest();
        manifest = await this.queryPersonalizationManifest(
          'DeveloperDiskImage',
          imageHash,
        );
        log.debug(
          'Successfully retrieved existing personalization manifest from device',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('MissingManifestError')
        ) {
          log.debug(
            'Personalization manifest not found on device, restarting connection and using TSS...',
          );
          // Check if we need to add this with a new iOS device that doesn't have a manifest stored
          // await this.connectToMobileImageMounterService();

          // Get device personalization identifiers to extract ECID
          const personalizationIdentifiers =
            await this.queryPersonalizationIdentifiers();
          const ecid = personalizationIdentifiers.UniqueChipID as number;

          if (!ecid) {
            throw new Error(
              'Could not retrieve device ECID from personalization identifiers',
            );
          }

          manifest = await getManifestFromTSS(
            ecid,
            buildManifest,
            () => this.queryPersonalizationIdentifiers(),
            (personalizedImageType: string) =>
              this.queryNonce(personalizedImageType),
          );
          log.debug('Successfully generated manifest from TSS');
        } else {
          throw error;
        }
      }

      // Upload the image
      await this.uploadImage(
        MobileImageMounterService.IMAGE_TYPE,
        image,
        manifest,
      );

      // Mount the image with trust cache
      const extras = {
        ImageTrustCache: trustCache,
      };

      await this.mountImage(
        MobileImageMounterService.IMAGE_TYPE,
        manifest,
        extras,
      );
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
  async unmountImage(
    mountPath: string = MobileImageMounterService.MOUNT_PATH,
  ): Promise<void> {
    try {
      const request: PlistDictionary = {
        Command: 'UnmountImage',
        MountPath: mountPath,
      };

      const response = (await this.sendRequest(request)) as ImageMountResponse;

      // Handle specific error cases
      if (response.Error) {
        if (response.Error === 'UnknownCommand') {
          throw new Error(
            'Unmount command is not supported on this iOS version',
          );
        } else if (
          response.DetailedError?.includes('There is no matching entry')
        ) {
          throw new Error(`No mounted image found at path: ${mountPath}`);
        } else if (response.Error === 'InternalError') {
          throw new Error(
            `Internal error occurred while unmounting: ${JSON.stringify(response)}`,
          );
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

      const response = (await this.sendRequest(request)) as PlistDictionary;
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

      const response = (await this.sendRequest(request)) as PlistDictionary;
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

    const response = (await this.sendRequest(request)) as PlistDictionary;

    this.checkIfError(response);

    return response.PersonalizationIdentifiers as PlistDictionary;
  }

  /**
   * Copy devices info (only for mounted images)
   * @returns Promise resolving to the list of mounted devices
   */
  async copyDevices(): Promise<any[]> {
    try {
      const response = (await this.sendRequest(
        { Command: 'CopyDevices' },
        10000,
      )) as any;

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
  async queryPersonalizationManifest(
    imageType: string,
    signature: Buffer,
  ): Promise<Buffer> {
    try {
      const request = {
        Command: 'QueryPersonalizationManifest',
        PersonalizedImageType: imageType,
        ImageType: imageType,
        ImageSignature: signature,
      };

      const response = (await this.sendRequest(
        request,
        10000,
      )) as PlistDictionary;

      this.checkIfError(response);

      // The response "ImageSignature" is an IM4M manifest
      const manifest = response.ImageSignature;

      if (!manifest) {
        throw new Error(
          'MissingManifestError: Personalization manifest not found on device',
        );
      }

      if (!Buffer.isBuffer(manifest)) {
        throw new Error('Invalid manifest received from device');
      }

      return manifest;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('MissingManifestError')
      ) {
        throw error;
      }
      throw new Error(
        'MissingManifestError: Personalization manifest not found on device',
      );
    }
  }

  /**
   * Upload image to device
   * @param imageType The image type
   * @param image The image data
   * @param signature The image signature/manifest
   */
  async uploadImage(
    imageType: string,
    image: Buffer,
    signature: Buffer,
  ): Promise<void> {
    try {
      // Send ReceiveBytes command
      const receiveBytesResult = (await this.sendRequest({
        Command: 'ReceiveBytes',
        ImageType: imageType,
        ImageSize: image.length,
        ImageSignature: signature,
      })) as ReceiveBytesResponse;

      this.checkIfError(receiveBytesResult);

      if (receiveBytesResult.Status !== 'ReceiveBytesAck') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on sending ReceiveBytes: ${JSON.stringify(receiveBytesResult)}`,
        );
      }

      // Send image data
      const conn = await this.connectToMobileImageMounterService();
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

      // Wait for upload completion
      const uploadResult = await conn.receive(20000);
      if (uploadResult.Status !== 'Complete') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on pushing image file: ${JSON.stringify(uploadResult)}`,
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
  async mountImage(
    imageType: string,
    signature: Buffer,
    extras?: Record<string, any>,
  ): Promise<void> {
    try {
      const request: PlistDictionary = {
        Command: 'MountImage',
        ImageType: imageType,
        ImageSignature: signature,
      };

      if (extras) {
        Object.assign(request, extras);
      }

      const response = (await this.sendRequest(request)) as ImageMountResponse;

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
    timeout?: number,
  ): Promise<PlistDictionary> {
    // Check if we're creating a new connection or reusing an existing one
    const isNewConnection =
      !this.connection ||
      (() => {
        try {
          const socket = this.connection!.getSocket();
          return !socket || socket.destroyed;
        } catch {
          return true;
        }
      })();

    const conn = await this.connectToMobileImageMounterService();

    const res = await conn.sendPlistRequest(request, timeout);

    // Check if this is a StartService response (new connection) or actual response (reused connection)
    if (
      isNewConnection &&
      res &&
      typeof res === 'object' &&
      res.Request === 'StartService'
    ) {
      try {
        const response = await conn.receive();
        if (!response) {
          return {};
        }

        if (Array.isArray(response)) {
          return response.length > 0 ? (response[0] as PlistDictionary) : {};
        }

        return response as PlistDictionary;
      } catch (receiveError) {
        throw receiveError;
      }
    } else {
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
  private async connectToMobileImageMounterService(
    forceNew = false,
  ): Promise<ServiceConnection> {
    // Return existing connection if available and not forcing new
    if (!forceNew && this.connection) {
      try {
        // Check if connection is still alive by accessing the socket
        const socket = this.connection.getSocket();
        if (socket && !socket.destroyed) {
          return this.connection;
        }
      } catch (error) {
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
  private async assertIsFile(
    filePath: string,
    fileType: string,
  ): Promise<Stats> {
    try {
      const fileStat = await fs.stat(filePath);

      if (fileStat.isDirectory()) {
        throw new Error(
          `The provided ${fileType} path is expected to be a file, but a directory was given: ${filePath}`,
        );
      }

      return fileStat;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(
          `The provided ${fileType} path does not exist: ${filePath}`,
        );
      }
      throw error;
    }
  }
}

export default MobileImageMounterService;
export { MobileImageMounterService };
