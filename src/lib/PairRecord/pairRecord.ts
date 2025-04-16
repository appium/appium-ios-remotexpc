import fs from 'fs';
import path from 'path';

/**
 * Interface defining the structure of a pair record.
 */
export interface PairRecord {
    HostID: string | null;
    SystemBUID: string | null;
    HostCertificate: string | null;
    HostPrivateKey: string | null;
    DeviceCertificate: string | null;
    RootCertificate: string | null;
    RootPrivateKey: string | null;
    WiFiMACAddress: string | null;
    EscrowBag: string | null;
}

/**
 * Interface for the raw response from plist.parsePlist
 */
export interface RawPairRecordResponse {
    HostID: string;
    SystemBUID: string;
    HostCertificate: Buffer;
    HostPrivateKey: Buffer;
    DeviceCertificate: Buffer;
    RootCertificate: Buffer;
    RootPrivateKey: Buffer;
    WiFiMACAddress: string;
    EscrowBag: Buffer;
}

/**
 * Converts a buffer containing PEM data to a string
 * @param buffer - Buffer containing PEM data
 * @returns String representation of the PEM data
 */
function bufferToPEMString(buffer: Buffer): string {
    return buffer.toString('utf8');
}

/**
 * Processes raw response from plist.parsePlist and formats it into a proper PairRecord
 * @param response - Response from plist.parsePlist(data.payload.PairRecordData)
 * @returns Formatted PairRecord object with properly structured data
 */
export function processPlistResponse(response: RawPairRecordResponse): PairRecord {
    return {
        HostID: response.HostID || null,
        SystemBUID: response.SystemBUID || null,
        HostCertificate: response.HostCertificate ? bufferToPEMString(response.HostCertificate) : null,
        HostPrivateKey: response.HostPrivateKey ? bufferToPEMString(response.HostPrivateKey) : null,
        DeviceCertificate: response.DeviceCertificate ? bufferToPEMString(response.DeviceCertificate) : null,
        RootCertificate: response.RootCertificate ? bufferToPEMString(response.RootCertificate) : null,
        RootPrivateKey: response.RootPrivateKey ? bufferToPEMString(response.RootPrivateKey) : null,
        WiFiMACAddress: response.WiFiMACAddress || null,
        // For EscrowBag, we need it as a base64 string
        EscrowBag: response.EscrowBag ? response.EscrowBag.toString('base64') : null
    };
}

/* --- File storage functions remain unchanged --- */

const RECORDS_DIR = path.join(process.cwd(), '../../.records');

async function ensureRecordsDirectoryExists(): Promise<void> {
    try {
        await fs.promises.mkdir(RECORDS_DIR, { recursive: true, mode: 0o777 });
    } catch (error) {
        console.error(`Failed to create directory ${RECORDS_DIR}:`, error);
        throw error;
    }
}

/**
 * Saves a pair record to the filesystem.
 * @param udid - Device UDID.
 * @param pairRecord - Pair record to save.
 * @returns Promise that resolves when record is saved.
 */
export async function savePairRecord(udid: string, pairRecord: PairRecord): Promise<void> {
    await ensureRecordsDirectoryExists();

    const recordPath = path.join(RECORDS_DIR, `${udid}-record.json`);
    try {
        await fs.promises.writeFile(
            recordPath,
            JSON.stringify(pairRecord, null, 2),
            { mode: 0o777 }
        );
        console.log(`Pair record saved: ${recordPath}`);
    } catch (error) {
        console.error(`Failed to save pair record for ${udid}:`, error);
        throw error;
    }
}

/**
 * Gets a saved pair record from the filesystem.
 * @param udid - Device UDID.
 * @returns Promise that resolves with the pair record or null if not found.
 */
export async function getPairRecord(udid: string): Promise<PairRecord | null> {
    const recordPath = path.join(RECORDS_DIR, `${udid}-record.json`);

    try {
        const data = await fs.promises.readFile(recordPath, 'utf8');
        return JSON.parse(data) as PairRecord;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }

        console.error(`Failed to read pair record for ${udid}:`, error);
        throw error;
    }
}