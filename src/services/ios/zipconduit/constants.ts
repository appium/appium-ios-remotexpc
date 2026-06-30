/** Observed Xcode directory permission value (0o755). */
export const STD_DIR_PERM = 16877;

/** Observed Xcode file permission value (0o644). */
export const STD_FILE_PERM = -32348;

export const METAINF_FILE_NAME = 'com.apple.ZipMetadata.plist';

/** Fake central directory signature sent after the streaming payload. */
export const CENTRAL_DIRECTORY_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/**
 * Fixed 32-byte UT extra field observed in Xcode zip_conduit traffic.
 * https://commons.apache.org/proper/commons-compress/apidocs/org/apache/commons/compress/archivers/zip/X5455_ExtendedTimestamp.html
 */
export const ZIP_EXTRA_BYTES = Buffer.from('55540D0007F3A2EC60F6A2EC60F3A2EC6075780B000104F50100000414000000', 'hex');

export const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
export const ZIP_HEADER_LAST_MODIFIED_TIME = 0xbdef;
export const ZIP_HEADER_LAST_MODIFIED_DATE = 0x52ec;

export const COPY_BUFFER_SIZE = 32 * 1024;

/** Socket write size while streaming entry payloads (match AFC push chunking). */
export const TRANSFER_CHUNK_SIZE = 1024 * 1024;

export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
