import { StorageObject } from '@prisma/client';

export class ObjectUploadedEvent {
  constructor(public readonly object: StorageObject) {}

  get objectId(): string {
    return this.object.id;
  }

  get mimeType(): string {
    return this.object.mimeType;
  }

  get storageKey(): string {
    return this.object.storageKey;
  }

  get name(): string {
    return this.object.name;
  }

  get size(): bigint {
    return this.object.size;
  }
}

export const OBJECT_UPLOADED_EVENT = 'storage.object.uploaded';
