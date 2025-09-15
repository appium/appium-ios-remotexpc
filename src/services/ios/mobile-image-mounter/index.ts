import { logger } from '@appium/support';
import { createHash } from 'crypto';
import { Stats, promises as fs } from 'fs';
import { performance } from 'perf_hooks';
import { Readable } from 'stream';

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
 * Base interface for service responses
 */
interface BaseResponse {
  Status?: string;
  Error?: string;
  DetailedError?: string;
}

/**
 * Interface for image-related responses
 */
export interface ImageResponse extends BaseResponse {
  ImagePresent?: boolean;
  ImageSignature?: Buffer[] | Buffer;
}

/**
 * MobileImageMounterService provides an API to:
 * - Mount Developer Disk Images on iOS devices
 * - Lookup mounted images and their signatures
 * - Check if personalized images are mounted
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
  private static readonly UPLOAD_IMAGE_TIMEOUT = 20000;

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
   * Lookup mounted images by type
   * @param imageType Type of image to lookup (defaults to 'Personalized')
   * @returns Array of signatures of mounted images
   */
  async lookup(
    imageType = MobileImageMounterService.IMAGE_TYPE,
  ): Promise<Buffer[]> {
    const response = (await this.sendRequest({
      Command: 'LookupImage',
      ImageType: imageType,
    })) as ImageResponse;

    const signatures = response.ImageSignature || [];
    return signatures.filter(Buffer.isBuffer) as Buffer[];
  }

  /**
   * Check if personalized image is mounted
   * @returns True if personalized image is mounted
   */
  async isPersonalizedImageMounted(): Promise<boolean> {
    try {
      return (await this.lookup()).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Mount personalized image for device (iOS >= 17)
   * @param imageFilePath Path to the image file (.dmg)
   * @param buildManifestFilePath Path to the build manifest file (.plist)
   * @param trustCacheFilePath Path to the trust cache file (.trustcache)
   * @param infoPlist Optional info plist dictionary
   */
  async mount(
    imageFilePath: string,
    buildManifestFilePath: string,
    trustCacheFilePath: string,
    infoPlist?: PlistDictionary,
  ): Promise<void> {
    if (await this.isPersonalizedImageMounted()) {
      log.info('Personalized image is already mounted');
      return;
    }

    const start = performance.now();

    // Validate files and read content
    await Promise.all([
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

    const [image, trustCache, buildManifestContent] = await Promise.all([
      fs.readFile(imageFilePath),
      fs.readFile(trustCacheFilePath),
      fs.readFile(buildManifestFilePath, 'utf8'),
    ]);

    const buildManifest = parseXmlPlist(
      buildManifestContent,
    ) as PlistDictionary;
    const manifest = await this.getOrRetrieveManifestFromTSS(
      image,
      buildManifest,
    );

    await this.uploadImage(
      MobileImageMounterService.IMAGE_TYPE,
      image,
      manifest,
    );

    const extras: Record<string, any> = {
      ImageTrustCache: trustCache,
    };

    if (infoPlist) {
      extras.ImageInfoPlist = infoPlist;
    }

    await this.mountImage(
      MobileImageMounterService.IMAGE_TYPE,
      manifest,
      extras,
    );

    const end = performance.now();
    log.info(
      `Successfully mounted personalized image in ${(end - start).toFixed(2)} ms`,
    );
  }

  /**
   * Unmount image from device
   * @param mountPath Mount path to unmount (defaults to '/System/Developer')
   */
  async unmountImage(
    mountPath = MobileImageMounterService.MOUNT_PATH,
  ): Promise<void> {
    const response = (await this.sendRequest({
      Command: 'UnmountImage',
      MountPath: mountPath,
    })) as BaseResponse;

    if (response.Error === 'UnknownCommand') {
      throw new Error('Unmount command is not supported on this iOS version');
    }
    if (response.DetailedError?.includes('There is no matching entry')) {
      throw new Error(`No mounted image found at path: ${mountPath}`);
    }
    if (response.Error === 'InternalError') {
      throw new Error(
        `Internal error occurred while unmounting: ${JSON.stringify(response)}`,
      );
    }

    this.checkIfError(response);
    log.info(`Successfully unmounted image from ${mountPath}`);
  }

  /**
   * Query developer mode status (iOS 16+)
   * @returns True if developer mode is enabled (defaults to true for older iOS)
   */
  async queryDeveloperModeStatus(): Promise<boolean> {
    try {
      const response = await this.sendRequest({
        Command: 'QueryDeveloperModeStatus',
      });
      this.checkIfError(response);
      return Boolean(response.DeveloperModeStatus);
    } catch {
      return true; // Default for older iOS versions
    }
  }

  /**
   * Query personalization nonce for personalized images
   * @param personalizedImageType Optional personalized image type
   * @returns Personalization nonce as Buffer
   */
  async queryNonce(personalizedImageType?: string): Promise<Buffer> {
    const request: PlistDictionary = { Command: 'QueryNonce' };
    if (personalizedImageType) {
      request.PersonalizedImageType = personalizedImageType;
    }

    const response = await this.sendRequest(request);
    this.checkIfError(response);

    const nonce = response.PersonalizationNonce;
    if (!Buffer.isBuffer(nonce)) {
      throw new Error('Invalid nonce received from device');
    }
    return nonce;
  }

  /**
   * Query personalization identifiers from the device
   * @returns Personalization identifiers dictionary
   */
  async queryPersonalizationIdentifiers(): Promise<PlistDictionary> {
    const response = await this.sendRequest({
      Command: 'QueryPersonalizationIdentifiers',
    });
    this.checkIfError(response);
    return response.PersonalizationIdentifiers as PlistDictionary;
  }

  /**
   * Copy devices info (only for mounted images)
   * @returns List of mounted devices
   */
  async copyDevices(): Promise<any[]> {
    const response = await this.sendRequest({ Command: 'CopyDevices' });
    return (response.EntryList as any[]) || [];
  }

  /**
   * Query personalization manifest from device
   * @param imageType The image type
   * @param signature The image signature/hash
   * @returns Personalization manifest as Buffer
   */
  async queryPersonalizationManifest(
    imageType: string,
    signature: Buffer,
  ): Promise<Buffer> {
    try {
      const response = await this.sendRequest({
        Command: 'QueryPersonalizationManifest',
        PersonalizedImageType: imageType,
        ImageType: imageType,
        ImageSignature: signature,
      });

      this.checkIfError(response);
      const manifest = response.ImageSignature;

      if (!manifest || !Buffer.isBuffer(manifest)) {
        throw new Error(
          'MissingManifestError: Personalization manifest not found on device',
        );
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
   * @param timeout Optional timeout for upload operation (defaults to 20000ms)
   */
  async uploadImage(
    imageType: string,
    image: Buffer,
    signature: Buffer,
    timeout = MobileImageMounterService.UPLOAD_IMAGE_TIMEOUT,
  ): Promise<void> {
    const receiveBytesResult = (await this.sendRequest({
      Command: 'ReceiveBytes',
      ImageType: imageType,
      ImageSize: image.length,
      ImageSignature: signature,
    })) as BaseResponse;

    this.checkIfError(receiveBytesResult);

    if (receiveBytesResult.Status !== 'ReceiveBytesAck') {
      throw new Error(
        `Unexpected return from mobile_image_mounter: ${JSON.stringify(receiveBytesResult)}`,
      );
    }

    const conn = await this.connectToMobileImageMounterService();
    const socket = conn.getSocket();

    await new Promise<void>((resolve, reject) => {
      socket.write(image, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });

    const uploadResult = await conn.receive(timeout);
    if (uploadResult.Status !== 'Complete') {
      throw new Error(`Image upload failed: ${JSON.stringify(uploadResult)}`);
    }

    log.debug('Image uploaded successfully');
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
    const request = {
      Command: 'MountImage',
      ImageType: imageType,
      ImageSignature: signature,
      ...extras,
    };

    const response = (await this.sendRequest(request)) as BaseResponse;

    if (response.DetailedError?.includes('is already mounted')) {
      log.info('Image was already mounted');
      return;
    }

    if (response.DetailedError?.includes('Developer mode is not enabled')) {
      throw new Error('Developer mode is not enabled on this device');
    }

    this.checkIfError(response);

    if (response.Status !== 'Complete') {
      throw new Error(`Mount image failed: ${JSON.stringify(response)}`);
    }

    log.debug('Image mounted successfully');
  }

  private async sendRequest(
    request: PlistDictionary,
    timeout?: number,
  ): Promise<PlistDictionary> {
    const isNewConnection = !this.connection || this.isConnectionDestroyed();
    const conn = await this.connectToMobileImageMounterService();
    const res = await conn.sendPlistRequest(request, timeout);

    if (isNewConnection && res?.Request === 'StartService') {
      return await conn.receive();
    }
    return res;
  }

  /**
   * Calculate hash of a buffer asynchronously
   * @param buffer The buffer to hash
   * @returns Promise resolving to the hash digest
   */
  private async hashLargeBufferAsync(buffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha384');
      const stream = Readable.from(buffer);

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });

      stream.on('end', () => {
        resolve(hash.digest());
      });

      stream.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async getOrRetrieveManifestFromTSS(
    image: Buffer,
    buildManifest: PlistDictionary,
  ): Promise<Buffer> {
    try {
      const imageHash = await this.hashLargeBufferAsync(image);
      const manifest = await this.queryPersonalizationManifest(
        'DeveloperDiskImage',
        imageHash,
      );
      log.debug(
        'Successfully retrieved existing personalization manifest from device',
      );
      return manifest;
    } catch (error) {
      if ((error as Error).message?.includes('MissingManifestError')) {
        log.debug('Personalization manifest not found on device, using TSS...');

        const identifiers = await this.queryPersonalizationIdentifiers();

        const manifest = await getManifestFromTSS(
          identifiers,
          buildManifest,
          (type: string) => this.queryNonce(type),
        );

        log.debug('Successfully generated manifest from TSS');
        return manifest;
      }
      throw error;
    }
  }

  private isConnectionDestroyed(): boolean {
    try {
      const socket = this.connection!.getSocket();
      return !socket || socket.destroyed;
    } catch {
      return true;
    }
  }

  private async connectToMobileImageMounterService(): Promise<ServiceConnection> {
    if (this.connection && !this.isConnectionDestroyed()) {
      return this.connection;
    }

    const newConnection = await this.startLockdownService({
      serviceName: MobileImageMounterService.RSD_SERVICE_NAME,
      port: this.address[1].toString(),
    });

    this.connection = newConnection;
    return newConnection;
  }

  private closeConnection(): void {
    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
    }
  }

  private checkIfError(response: BaseResponse): void {
    if (response.Error) {
      throw new Error(response.Error);
    }
  }

  private async assertIsFile(
    filePath: string,
    fileType: string,
  ): Promise<Stats> {
    try {
      const fileStat = await fs.stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error(`Expected ${fileType} file, got non-file: ${filePath}`);
      }
      return fileStat;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`${fileType} file not found: ${filePath}`);
      }
      throw error;
    }
  }
}

export default MobileImageMounterService;
export { MobileImageMounterService };
