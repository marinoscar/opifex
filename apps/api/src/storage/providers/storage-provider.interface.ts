import { Readable } from 'node:stream';
import {
  StorageUploadOptions,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
} from './storage-provider.types';

/**
 * Dependency injection token for storage provider
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/**
 * Abstract interface for file storage providers
 * Supports both simple uploads and multipart resumable uploads
 */
export interface StorageProvider {
  /**
   * Simple upload for small to medium files
   * Stream is uploaded directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param stream - Readable stream of file content
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload result with location and metadata
   */
  upload(
    key: string,
    stream: Readable,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult>;

  /**
   * Initialize a multipart upload for large files or resumable uploads
   *
   * @param key - Unique identifier for the file in storage
   * @param options - Upload configuration (MIME type, metadata, etc.)
   * @returns Upload ID and key for subsequent operations
   */
  initMultipartUpload(
    key: string,
    options: StorageUploadOptions,
  ): Promise<MultipartUploadInit>;

  /**
   * Generate a signed URL for uploading a specific part
   * Client can use this URL to upload parts directly to storage
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param partNumber - Part number (1-based index)
   * @param expiresIn - URL expiration time in seconds (default: 3600)
   * @returns Pre-signed URL for part upload
   */
  getSignedUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn?: number,
  ): Promise<string>;

  /**
   * Complete a multipart upload after all parts are uploaded
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   * @param parts - Array of uploaded parts with part numbers and ETags
   * @returns Upload result with final location
   */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<StorageUploadResult>;

  /**
   * Abort a multipart upload and clean up parts
   *
   * @param key - Unique identifier for the file in storage
   * @param uploadId - Upload ID from initMultipartUpload
   */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /**
   * Download a file as a readable stream
   *
   * @param key - Unique identifier for the file in storage
   * @returns Readable stream of file content
   */
  download(key: string): Promise<Readable>;

  /**
   * Generate a signed URL for downloading a file
   * Allows temporary access without authentication
   *
   * @param key - Unique identifier for the file in storage
   * @param options - URL generation options (expiration, content disposition)
   * @returns Pre-signed URL for file download
   */
  getSignedDownloadUrl(
    key: string,
    options?: SignedUrlOptions,
  ): Promise<string>;

  /**
   * Delete a file from storage
   *
   * @param key - Unique identifier for the file in storage
   */
  delete(key: string): Promise<void>;

  /**
   * Get file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @returns Metadata key-value pairs, or null if file doesn't exist
   */
  getMetadata(key: string): Promise<Record<string, string> | null>;

  /**
   * Set or update file metadata
   *
   * @param key - Unique identifier for the file in storage
   * @param metadata - Metadata key-value pairs to set
   */
  setMetadata(key: string, metadata: Record<string, string>): Promise<void>;

  /**
   * Check if a file exists in storage
   *
   * @param key - Unique identifier for the file in storage
   * @returns True if file exists, false otherwise
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get the bucket name being used by this provider
   *
   * @returns Bucket name
   */
  getBucket(): string;
}
