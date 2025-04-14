import { Transform, type TransformCallback } from 'stream';

/**
 * Options for LengthBasedSplitter
 */
export interface LengthBasedSplitterOptions {
    readableStream?: NodeJS.ReadableStream;
    littleEndian?: boolean;
    maxFrameLength?: number;
    lengthFieldOffset?: number;
    lengthFieldLength?: number;
    lengthAdjustment?: number;
}

/**
 * Splits incoming data into length-prefixed chunks
 */
export class LengthBasedSplitter extends Transform {
    private buffer: Buffer;
    private littleEndian: boolean;
    private maxFrameLength: number;
    private lengthFieldOffset: number;
    private lengthFieldLength: number;
    private lengthAdjustment: number;
    private isXmlMode: boolean = false;
    private xmlBuffer: Buffer = Buffer.alloc(0);

    /**
     * Creates a new LengthBasedSplitter
     * @param options Configuration options
     */
    constructor(options: LengthBasedSplitterOptions = {}) {
        super();
        this.buffer = Buffer.alloc(0);
        this.littleEndian = options.littleEndian ?? false;
        this.maxFrameLength = options.maxFrameLength ?? 1024 * 1024; // 1MB default
        this.lengthFieldOffset = options.lengthFieldOffset ?? 0;
        this.lengthFieldLength = options.lengthFieldLength ?? 4;
        this.lengthAdjustment = options.lengthAdjustment ?? 0;

        // If readableStream is provided, pipe it to this
        if (options.readableStream) {
            options.readableStream.pipe(this);
        }
    }

    /**
     * Shutdown the splitter and remove all listeners
     */
    shutdown(): void {
        this.removeAllListeners();
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            // Add the new chunk to our buffer
            this.buffer = Buffer.concat([this.buffer, chunk]);

            // Check if this is XML data before doing any other processing
            const bufferString = this.buffer.toString('utf8', 0, Math.min(100, this.buffer.length));
            if (bufferString.includes('<?xml') || bufferString.includes('<plist') || this.isXmlMode) {
                // This is XML data, set XML mode
                this.isXmlMode = true;
                this.processXmlData(callback);
                return;
            }

            // Process as many complete messages as possible for binary data
            this.processBinaryData(callback);
        } catch (err) {
            console.error('Unexpected error in LengthBasedSplitter:', err);
            // Don't fail the transform - just log the error and continue
            callback();
        }
    }

    /**
     * Process data as XML
     */
    private processXmlData(callback: TransformCallback): void {
        const fullBufferString = this.buffer.toString('utf8');

        // Look for a complete XML document
        const plistEndIndex = fullBufferString.indexOf('</plist>');

        if (plistEndIndex >= 0) {
            // Found the end of the plist
            const endPos = plistEndIndex + '</plist>'.length;
            const xmlData = this.buffer.slice(0, endPos);

            // Push the complete XML data
            this.push(xmlData);

            // Remove the processed data from buffer
            this.buffer = this.buffer.slice(endPos);

            // Check if there's more data in the buffer
            if (this.buffer.length === 0) {
                this.isXmlMode = false;
            } else {
                // Check if the next chunk is also XML
                const remainingData = this.buffer.toString('utf8', 0, Math.min(100, this.buffer.length));
                if (!remainingData.includes('<?xml') && !remainingData.includes('<plist')) {
                    this.isXmlMode = false;
                }
            }
        }

        callback();
    }

    /**
     * Process data as binary with length prefix
     */
    private processBinaryData(callback: TransformCallback): void {
        while (this.buffer.length >= this.lengthFieldOffset + this.lengthFieldLength) {
            let messageLength: number;

            // Read the length prefix according to configuration
            if (this.lengthFieldLength === 4) {
                messageLength = this.littleEndian
                    ? this.buffer.readUInt32LE(this.lengthFieldOffset)
                    : this.buffer.readUInt32BE(this.lengthFieldOffset);
            } else if (this.lengthFieldLength === 2) {
                messageLength = this.littleEndian
                    ? this.buffer.readUInt16LE(this.lengthFieldOffset)
                    : this.buffer.readUInt16BE(this.lengthFieldOffset);
            } else if (this.lengthFieldLength === 1) {
                messageLength = this.buffer.readUInt8(this.lengthFieldOffset);
            } else if (this.lengthFieldLength === 8) {
                const high = this.littleEndian
                    ? this.buffer.readUInt32LE(this.lengthFieldOffset + 4)
                    : this.buffer.readUInt32BE(this.lengthFieldOffset);
                const low = this.littleEndian
                    ? this.buffer.readUInt32LE(this.lengthFieldOffset)
                    : this.buffer.readUInt32BE(this.lengthFieldOffset + 4);
                messageLength = high * 0x100000000 + low;
            } else {
                throw new Error(`Unsupported lengthFieldLength: ${this.lengthFieldLength}`);
            }

            // Apply adjustment
            messageLength += this.lengthAdjustment;

            // Check if the extracted message length seems suspicious
            if (messageLength < 0 || messageLength > this.maxFrameLength) {
                // If length is invalid, check if this might actually be XML
                const suspiciousData = this.buffer.toString('utf8', 0, Math.min(100, this.buffer.length));
                if (suspiciousData.includes('<?xml') || suspiciousData.includes('<plist')) {
                    this.isXmlMode = true;
                    // Process as XML on next iteration
                    return callback();
                }

                // Invalid length - skip one byte and try again
                this.buffer = this.buffer.slice(1);
                continue;
            }

            // Total length of frame = lengthFieldOffset + lengthFieldLength + messageLength
            const totalLength = this.lengthFieldOffset + this.lengthFieldLength + messageLength;

            // If we don't have the complete message yet, wait for more data
            if (this.buffer.length < totalLength) {
                break;
            }

            // Extract the message
            try {
                // Extract the complete message
                const message = this.buffer.slice(0, totalLength);

                // Check if this message is actually XML
                const messageStart = message.toString('utf8', 0, Math.min(100, message.length));
                if (messageStart.includes('<?xml') || messageStart.includes('<plist')) {
                    // Switch to XML mode
                    this.isXmlMode = true;
                    return callback();
                }

                // Push the message
                this.push(message);

                // Remove the processed message from the buffer
                this.buffer = this.buffer.slice(totalLength);
            } catch (extractError) {
                console.error('Error extracting message:', extractError);
                // Skip this problematic message - move forward by 1 byte and try again
                this.buffer = this.buffer.slice(1);
            }
        }

        callback();
    }
}

export default LengthBasedSplitter;