
/**
 * Options for uploading a file to storage
 */
export interface StorageUploadOptions {
  mimeType: string;
  metadata?: Record<string, string>;
  contentLength?: number;
}

/**
 * Result of a successful upload operation
 */
export interface StorageUploadResult {
  key: string;
  bucket: string;
  location: string;
  eTag?: string;
}

/**
 * Represents a completed part of a multipart upload
 */
export interface UploadPart {
  partNumber: number;
  eTag: string;
}

/**
 * Options for generating signed URLs
 */
export interface SignedUrlOptions {
  expiresIn?: number; // Seconds, default 3600
  responseContentDisposition?: string;
}

/**
 * Result of initiating a multipart upload
 */
export interface MultipartUploadInit {
  uploadId: string;
  key: string;
}
