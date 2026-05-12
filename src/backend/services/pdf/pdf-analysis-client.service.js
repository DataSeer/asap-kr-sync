/**
 * PDF Analysis LM API Client Service
 */

const axios = require('axios');
const pdfAnalysisConfig = require('../../config/pdf-analysis-api');
const { ExternalServiceError } = require('../../utils/errors');
const { retry } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * Create axios instance for LM API
 */
const apiClient = axios.create({
  baseURL: pdfAnalysisConfig.baseUrl,
  timeout: pdfAnalysisConfig.timeout,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add authorization header dynamically (allows for token refresh)
apiClient.interceptors.request.use((config) => {
  const authHeader = pdfAnalysisConfig.getAuthHeader();
  if (authHeader) {
    config.headers.Authorization = authHeader;
  }
  return config;
});

/**
 * Send PDF analysis request
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {Array} krtData - Current KRT rows
 * @returns {Promise<object>} Analysis response
 */
async function request(pdfBuffer, krtData) {
  try {
    const response = await retry(
      async () => {
        // Convert PDF buffer to base64 for API
        const pdfBase64 = pdfBuffer.toString('base64');

        const result = await apiClient.post(pdfAnalysisConfig.endpoints.analyze, {
          pdf: pdfBase64,
          krt: krtData,
          options: {
            extractResources: true,
            validateIdentifiers: true,
            suggestMissing: true
          }
        });

        return result.data;
      },
      {
        maxRetries: pdfAnalysisConfig.retryConfig.maxRetries,
        delay: pdfAnalysisConfig.retryConfig.retryDelay,
        multiplier: pdfAnalysisConfig.retryConfig.retryDelayMultiplier,
        onRetry: (attempt, waitTime, error) => {
          logger.warn(`LM API retry attempt ${attempt}`, {
            waitTime,
            error: error.message
          });
        }
      }
    );

    logger.info('LM API analysis completed', {
      findingsCount: response.findings?.length || 0
    });

    return response;
  } catch (error) {
    logger.error('LM API error', { error: error.message });

    // Handle specific error types
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error || error.message;

      if (status === 401) {
        throw new ExternalServiceError('LM API', 'Authentication failed');
      }
      if (status === 429) {
        throw new ExternalServiceError('LM API', 'Rate limit exceeded');
      }
      if (status >= 500) {
        throw new ExternalServiceError('LM API', 'Service unavailable');
      }

      throw new ExternalServiceError('LM API', message);
    }

    if (error.code === 'ECONNABORTED') {
      throw new ExternalServiceError('LM API', 'Request timeout');
    }

    throw new ExternalServiceError('LM API', error.message);
  }
}

/**
 * Check LM API health
 * @returns {Promise<boolean>}
 */
async function checkHealth() {
  try {
    const response = await apiClient.get(pdfAnalysisConfig.endpoints.status);
    return response.data.status === 'ok';
  } catch (error) {
    logger.warn('LM API health check failed', { error: error.message });
    return false;
  }
}

/**
 * Mock analysis for development/testing
 * @param {Array} krtData - Current KRT rows
 * @returns {object} Mock response
 */
function mockAnalysis(krtData) {
  // Generate mock findings for development
  return {
    status: 'complete',
    findings: [
      {
        type: 'add_row',
        title: 'Missing dataset reference',
        description: 'Found reference to dataset "Gene Expression Atlas" on page 5',
        pdfLocation: { page: 5, paragraph: 3 },
        confidence: 0.85,
        data: {
          resourceType: 'Dataset',
          resourceName: 'Gene Expression Atlas',
          source: 'EMBL-EBI',
          identifier: 'https://www.ebi.ac.uk/gxa',
          newReuse: 'reuse',
          additionalInformation: ''
        }
      },
      {
        type: 'edit',
        title: 'Identifier correction',
        description: 'Found more specific identifier for existing resource',
        pdfLocation: { page: 3, paragraph: 1 },
        confidence: 0.92,
        data: {
          rowId: krtData[0]?.id,
          column: 'identifier',
          oldValue: krtData[0]?.identifier || '',
          newValue: '10.1234/example.doi'
        }
      }
    ]
  };
}

module.exports = {
  request,
  checkHealth,
  mockAnalysis
};
