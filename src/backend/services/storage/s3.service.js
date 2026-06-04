/**
 * AWS S3 Service
 */

const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3Client, bucketName, bucketPrefix, s3Endpoint } = require('../../config/aws');
const logger = require('../../utils/logger');


/**
 * Upload file to S3
 * @param {string} key - S3 key (path)
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - MIME type
 * @returns {Promise<string>} S3 URL
 */
async function uploadFile(key, buffer, mimeType) {
  const fullKey = `${bucketPrefix}${key}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fullKey,
    Body: buffer,
    ContentType: mimeType
  });

  try {
    await s3Client.send(command);
    logger.info('File uploaded to S3', { key: fullKey });
  } catch (error) {
    logger.error('S3 upload failed', { key: fullKey, error: error.message });
    throw new Error(`Failed to upload file to S3: ${error.message}`);
  }

  // Return appropriate URL based on storage backend
  if (s3Endpoint) {
    // MinIO or S3-compatible storage (path-style URL)
    return `${s3Endpoint}/${bucketName}/${fullKey}`;
  }
  // AWS S3 (virtual-hosted style URL)
  return `https://${bucketName}.s3.amazonaws.com/${fullKey}`;
}

/**
 * Download file from S3
 * @param {string} key - S3 key
 * @returns {Promise<Buffer>} File buffer
 */
async function downloadFile(key) {
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}${key}`;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fullKey
  });

  const response = await s3Client.send(command);
  const chunks = [];

  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Delete file from S3
 * @param {string} key - S3 key
 * @returns {Promise<void>}
 */
async function deleteFile(key) {
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}${key}`;

  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: fullKey
  });

  await s3Client.send(command);

  logger.info('File deleted from S3', { key: fullKey });
}

/**
 * Delete every object under a prefix (e.g. all files for a submission folder).
 * Pages through ListObjectsV2 and batches deletes (up to 1000 keys per call).
 *
 * Returns the total number of deleted objects.
 *
 * @param {string} prefix - S3 key prefix (without bucketPrefix; this function adds it)
 * @returns {Promise<number>}
 */
async function deletePrefix(prefix) {
  const fullPrefix = prefix.startsWith(bucketPrefix) ? prefix : `${bucketPrefix}${prefix}`;
  let totalDeleted = 0;
  let continuationToken;

  do {
    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: fullPrefix,
      ContinuationToken: continuationToken
    }));

    const objects = (listed.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length > 0) {
      await s3Client.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: objects, Quiet: true }
      }));
      totalDeleted += objects.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  logger.info('S3 prefix deleted', { prefix: fullPrefix, count: totalDeleted });
  return totalDeleted;
}

/**
 * Check if file exists in S3
 * @param {string} key - S3 key
 * @returns {Promise<boolean>}
 */
async function fileExists(key) {
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}${key}`;

  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: fullKey
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

/**
 * Generate presigned URL for download
 * @param {string} key - S3 key
 * @param {number} expiresIn - Expiration in seconds (default 1 hour)
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedDownloadUrl(key, expiresIn = 3600, downloadFilename) {
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}${key}`;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: fullKey,
    // When provided, force the browser to save the object under this name
    // (S3/MinIO echo this as the response's Content-Disposition header).
    ...(downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` }
      : {})
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate presigned URL for upload
 * @param {string} key - S3 key
 * @param {string} mimeType - Expected MIME type
 * @param {number} expiresIn - Expiration in seconds (default 1 hour)
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUploadUrl(key, mimeType, expiresIn = 3600) {
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}${key}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fullKey,
    ContentType: mimeType
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

module.exports = {
  uploadFile,
  downloadFile,
  deleteFile,
  deletePrefix,
  fileExists,
  getPresignedDownloadUrl,
  getPresignedUploadUrl
};
