/**
 * File Upload Middleware (Multer Configuration)
 */

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { ValidationError } = require('../utils/errors');
const { MAX_FILE_SIZES, SUPPORTED_KRT_FORMATS, SUPPORTED_PDF_FORMAT, SUPPORTED_DOCUMENT_FORMATS } = require('../config/constants');

// Memory storage for processing files before S3 upload
const storage = multer.memoryStorage();

/**
 * File filter for KRT files
 */
function krtFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (SUPPORTED_KRT_FORMATS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`Invalid file type. Supported formats: ${SUPPORTED_KRT_FORMATS.join(', ')}`));
  }
}

/**
 * File filter for PDF and DOCX files
 */
function pdfFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (SUPPORTED_DOCUMENT_FORMATS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`Invalid file type. Supported formats: ${SUPPORTED_DOCUMENT_FORMATS.join(', ')}`));
  }
}

/**
 * Multer instance for KRT uploads
 */
const uploadKRT = multer({
  storage,
  fileFilter: krtFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZES.KRT,
    files: 1
  }
});

/**
 * Multer instance for PDF uploads
 */
const uploadPDF = multer({
  storage,
  fileFilter: pdfFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZES.PDF,
    files: 1
  }
});

/**
 * Handle multer errors
 */
function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('File too large'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new ValidationError('Unexpected field'));
    }
    return next(new ValidationError(err.message));
  }
  next(err);
}

module.exports = {
  uploadKRT,
  uploadPDF,
  handleMulterError
};
