import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'node:stream';
import {
  ObjectProcessor,
  ObjectProcessorResult,
} from '../object-processor.interface';

/**
 * Example processor that demonstrates the processing pipeline.
 * This processor extracts basic metadata from uploaded files.
 *
 * To enable this processor, add it to the providers array in a module:
 *
 * @example
 * ```typescript
 * import { OBJECT_PROCESSOR } from './processing/object-processor.interface';
 * import { ExampleMetadataProcessor } from './processing/processors/example-metadata.processor';
 *
 * @Module({
 *   providers: [
 *     {
 *       provide: OBJECT_PROCESSOR,
 *       useClass: ExampleMetadataProcessor,
 *     },
 *   ],
 * })
 * export class SomeModule {}
 * ```
 */
@Injectable()
export class ExampleMetadataProcessor implements ObjectProcessor {
  private readonly logger = new Logger(ExampleMetadataProcessor.name);

  readonly name = 'example-metadata';
  readonly priority = 100; // Default priority

  /**
   * This example processor handles all objects
   */
  canProcess(object: StorageObject): boolean {
    // Process all objects for demonstration
    return true;
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      this.logger.debug(`Processing object: ${object.id}`);

      // Example: Read first few bytes to detect file signature
      const stream = await getStream();
      const firstChunk = await this.readFirstChunk(stream, 16);

      // Example metadata extraction
      const metadata = {
        processedAt: new Date().toISOString(),
        objectId: object.id,
        fileName: object.name,
        fileSize: object.size.toString(),
        mimeType: object.mimeType,
        firstBytes: firstChunk ? this.bytesToHex(firstChunk) : null,
      };

      this.logger.debug(`Extracted metadata for object ${object.id}`);

      return {
        success: true,
        metadata,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to process object ${object.id}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Read first N bytes from stream
   */
  private async readFirstChunk(
    stream: Readable,
    bytes: number,
  ): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      let chunk: Buffer | null = null;

      const onData = (data: Buffer) => {
        chunk = data.subarray(0, bytes);
        cleanup();
        resolve(chunk);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onEnd = () => {
        cleanup();
        resolve(chunk);
      };

      const cleanup = () => {
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
        stream.removeListener('end', onEnd);
        stream.destroy();
      };

      stream.once('data', onData);
      stream.once('error', onError);
      stream.once('end', onEnd);
    });
  }

  /**
   * Convert bytes to hex string
   */
  private bytesToHex(buffer: Buffer): string {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }
}
