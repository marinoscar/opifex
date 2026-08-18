import { StorageObject } from '@prisma/client';
import { Readable } from 'node:stream';

export const OBJECT_PROCESSOR = Symbol('OBJECT_PROCESSOR');

export interface ObjectProcessorResult {
  success: boolean;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface ObjectProcessor {
  /**
   * Unique name for this processor
   */
  readonly name: string;

  /**
   * Priority order (lower = earlier). Default: 100
   */
  readonly priority: number;

  /**
   * Check if this processor can handle the given object
   */
  canProcess(object: StorageObject): boolean;

  /**
   * Process the object asynchronously
   * @param object The storage object metadata
   * @param getStream Function to get a fresh stream of the object content
   * @returns Processing result with optional metadata
   */
  process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
  ): Promise<ObjectProcessorResult>;
}
