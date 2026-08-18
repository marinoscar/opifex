# Storage Object Processors

This directory contains processor implementations for the storage object processing pipeline.

## Overview

Processors are pluggable components that run asynchronously after a file is uploaded. They can:
- Extract metadata (dimensions, duration, etc.)
- Generate thumbnails or previews
- Scan for viruses
- Validate file integrity
- Index content for search
- Any other post-upload processing

## Creating a Processor

### 1. Implement the `ObjectProcessor` Interface

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';
import {
  ObjectProcessor,
  ObjectProcessorResult,
} from '../object-processor.interface';

@Injectable()
export class MyCustomProcessor implements ObjectProcessor {
  private readonly logger = new Logger(MyCustomProcessor.name);

  readonly name = 'my-custom-processor';
  readonly priority = 100; // Lower = runs earlier

  canProcess(object: StorageObject): boolean {
    // Return true if this processor should handle this object
    return object.mimeType.startsWith('image/');
  }

  async process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult> {
    try {
      // Get a fresh stream of the file content
      const stream = await getStream();

      // Do your processing...
      const metadata = {
        // Your extracted metadata
      };

      return {
        success: true,
        metadata,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
```

### 2. Register the Processor

Add your processor to the module where it should be used:

```typescript
import { Module } from '@nestjs/common';
import { OBJECT_PROCESSOR } from './processing/object-processor.interface';
import { MyCustomProcessor } from './processing/processors/my-custom.processor';

@Module({
  providers: [
    {
      provide: OBJECT_PROCESSOR,
      useClass: MyCustomProcessor,
    },
  ],
})
export class MyModule {}
```

### 3. Register Multiple Processors

To register multiple processors, use the `multi: true` option:

```typescript
@Module({
  providers: [
    {
      provide: OBJECT_PROCESSOR,
      useClass: ImageMetadataProcessor,
      multi: true,
    },
    {
      provide: OBJECT_PROCESSOR,
      useClass: ThumbnailGenerator,
      multi: true,
    },
    {
      provide: OBJECT_PROCESSOR,
      useClass: VirusScanner,
      multi: true,
    },
  ],
})
export class StorageProcessorsModule {}
```

## Processor Lifecycle

1. **Upload Complete**: Object status set to `processing`
2. **Event Emitted**: `OBJECT_UPLOADED_EVENT` fired
3. **Processor Selection**: `canProcess()` called on all registered processors
4. **Priority Sorting**: Applicable processors sorted by priority (lower first)
5. **Sequential Execution**: Each processor runs in order
6. **Metadata Aggregation**: Results merged into object metadata
7. **Status Update**: Object marked as `ready` (or `failed` if errors occurred)

## Metadata Storage

Each processor's results are stored in the object's metadata field:

```json
{
  "metadata": {
    "_processing": {
      "image-metadata": {
        "width": 1920,
        "height": 1080,
        "format": "jpeg"
      },
      "thumbnail-generator": {
        "thumbnailKey": "thumbnails/abc123.jpg"
      }
    },
    "_processedAt": "2025-01-24T10:30:00.000Z"
  }
}
```

## Error Handling

- Individual processor failures don't stop other processors
- Errors are logged and stored in metadata:
  ```json
  {
    "_processing": {
      "virus-scanner_error": "Scan timeout"
    },
    "_processingFailed": true
  }
  ```
- Object status set to `failed` if any processor fails

## Best Practices

1. **Idempotent Processing**: Ensure processors can be safely re-run
2. **Stream Handling**: Always destroy streams to prevent leaks
3. **Error Handling**: Catch all errors and return proper results
4. **Logging**: Use structured logging with object IDs
5. **Performance**: Keep processing fast; consider queues for heavy work
6. **Priority Order**: Set appropriate priority for dependencies

## Example Processors

See `example-metadata.processor.ts` for a basic implementation example.

Common processor types:
- **Metadata Extraction**: Extract file properties (dimensions, duration, etc.)
- **Preview Generation**: Create thumbnails, previews, or transcoded versions
- **Content Analysis**: OCR, image recognition, content classification
- **Security Scanning**: Virus scanning, content policy validation
- **Indexing**: Extract searchable text, tags, or embeddings
