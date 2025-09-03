import { logger } from '@appium/support';
import { promises as fs, Stats } from 'fs';
import path from 'path';

import type {
  MobileImageMounterService as MobileImageMounterServiceInterface,
  PlistDictionary,
} from '../../../lib/types.js';
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
  private static readonly FILE_TYPE_SIGNATURE = 'signature';
  private static readonly DEFAULT_IMAGE_TYPE = 'Personalized'; // The default image type for iOS >= 17 is Personalized
  private static readonly DEFAULT_MOUNT_PATH = '/private/var/mobile/Media/PublicStaging/staging.dimag';
  private static readonly DEVELOPER_MOUNT_PATH = '/System/Developer'; // default for Personalized images from iOS >= 17

  constructor(address: [string, number]) {
    super(address);
  }

  /**
   * Lookup for mounted images by type
   * @param imageType Type of image, 'Developer' by default
   * @returns Promise resolving to array of signatures of mounted images
   */
  async lookup(imageType: string = MobileImageMounterService.DEFAULT_IMAGE_TYPE): Promise<Buffer[]> {
    try {
      const request: PlistDictionary = {
        Command: 'LookupImage',
        ImageType: imageType,
      };

      const response = await this.sendRequest(request) as LookupImageResponse;
      log.debug(`LookupImage response received: ${JSON.stringify(response)}`);
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
      const signatures = await this.lookup(MobileImageMounterService.DEFAULT_IMAGE_TYPE);
      return signatures.length > 0;
    } catch (error) {
      log.debug(`Could not check if developer image is mounted: ${error}`);
      return false;
    }
  }

  /**
   * Mount image for device
   * @param imageFilePath The file path of the image
   * @param imageSignatureFilePath The signature file path of the given image
   * @param imageType Type of image, 'Developer' by default
   */
  async mount(
    imageFilePath: string,
    imageSignatureFilePath: string,
    imageType: string = MobileImageMounterService.DEFAULT_IMAGE_TYPE
  ): Promise<void> {
    try {
      // Check file stats and validate files exist
      const [imageFileStat] = await Promise.all([
        this.assertIsFile(imageFilePath, MobileImageMounterService.FILE_TYPE_IMAGE),
        this.assertIsFile(imageSignatureFilePath, MobileImageMounterService.FILE_TYPE_SIGNATURE),
      ]);

      // Read signature file
      const signature = await fs.readFile(imageSignatureFilePath);

      // Check if an image with the same signature is already mounted
      const mountedImages = await this.lookup(imageType);
      const isAlreadyMounted = mountedImages.some((mountedSignature) =>
        signature.equals(mountedSignature)
      );

      if (isAlreadyMounted) {
        log.info(`An image with same signature of ${imageSignatureFilePath} is already mounted. Doing nothing.`);
        return;
      }

      // Step 1: Notify device about incoming image
      const imageSize = imageFileStat.size;
      const receiveBytesResult = await this.sendRequest({
        Command: 'ReceiveBytes',
        ImageSignature: signature,
        ImageSize: imageSize,
        ImageType: imageType,
      }) as ReceiveBytesResponse;

      this.checkIfError(receiveBytesResult);

      if (receiveBytesResult.Status !== 'ReceiveBytesAck') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on sending ReceiveBytes: ${JSON.stringify(receiveBytesResult)}`
        );
      }

      // Step 2: Upload image data to device
      await this.uploadImageData(imageFilePath);

      // Step 3: Mount the uploaded image
      const mountResult = await this.sendRequest({
        Command: 'MountImage',
        ImagePath: MobileImageMounterService.DEFAULT_MOUNT_PATH,
        ImageSignature: signature,
        ImageType: imageType,
      }) as ImageMountResponse;

      // Handle case where image is already mounted
      if (mountResult.DetailedError?.includes('is already mounted at /Developer')) {
        log.info('DeveloperImage was already mounted');
        return;
      }

      this.checkIfError(mountResult);
      log.info(`Successfully mounted ${imageType} image`);
    } catch (error) {
      log.error(`Error mounting image: ${error}`);
      throw error;
    }
  }

  /**
   * Unmount image from device
   * @param mountPath The mount path to unmount, defaults to '/Developer'
   */
  async unmountImage(mountPath: string = MobileImageMounterService.DEVELOPER_MOUNT_PATH): Promise<void> {
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
    const conn = await this.connectToMobileImageMounterService();
    const _ = await conn.sendPlistRequest(request, timeout);
    const response = await conn.receive()

    log.debug(`${request.Command} response received`);

    if (!response) {
      return {};
    }

    if (Array.isArray(response)) {
      return response.length > 0 ? (response[0] as PlistDictionary) : {};
    }

    return response as PlistDictionary;
  }

  /**
   * Connect to the mobile image mounter service
   * @returns Promise resolving to a service connection
   */
  private async connectToMobileImageMounterService() {
    const service = {
      serviceName: MobileImageMounterService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    };

    return await this.startLockdownService(service);
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

  /**
   * Upload image data to the device
   * @param imageFilePath The path to the image file to upload
   */
  private async uploadImageData(imageFilePath: string): Promise<void> {
    try {
      // Read the image file
      const imageData = await fs.readFile(imageFilePath);

      // Get connection to send raw data
      const conn = await this.connectToMobileImageMounterService();

      // Get the underlying socket and send image data directly
      const socket = conn.getSocket();
      await new Promise<void>((resolve, reject) => {
        socket.write(imageData, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      // Wait for upload completion confirmation
      const pushImageResult = await conn.receive();

      if (pushImageResult.Status !== 'Complete') {
        throw new Error(
          `Unexpected return from mobile_image_mounter on pushing image file: ${JSON.stringify(pushImageResult)}`
        );
      }

      log.debug('Image data uploaded successfully');
    } catch (error) {
      log.error(`Error uploading image data: ${error}`);
      throw error;
    }
  }
}

export default MobileImageMounterService;
export { MobileImageMounterService };
