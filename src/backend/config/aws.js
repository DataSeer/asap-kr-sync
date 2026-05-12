/**
 * AWS S3 Configuration
 * Supports both AWS S3 and S3-compatible storage (MinIO, LocalStack, etc.)
 */

const { S3Client } = require('@aws-sdk/client-s3');

const s3Endpoint = process.env.S3_ENDPOINT;

// Validate required credentials
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.warn('Warning: AWS credentials not configured. S3 operations will fail.');
}

const s3Config = {
  region: process.env.AWS_REGION || 'us-east-1'
};

// Only add credentials if they're provided
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Config.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  };
}

// Add endpoint for S3-compatible storage (MinIO, LocalStack)
if (s3Endpoint) {
  s3Config.endpoint = s3Endpoint;
  s3Config.forcePathStyle = true; // Required for MinIO
}

const s3Client = new S3Client(s3Config);

module.exports = {
  s3Client,
  bucketName: process.env.S3_BUCKET_NAME || 'asap-kr-sync',
  bucketPrefix: process.env.S3_BUCKET_PREFIX || 'dev/',
  s3Endpoint
};
