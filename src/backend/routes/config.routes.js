/**
 * Config Routes
 * Public configuration endpoints
 */

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { KRT_TEMPLATE_URL, getResourceTypes, ROLES } = require('../config/constants');
const { PIPELINES, DEFAULT_PIPELINE_ID } = require('../config/pipelines');
const pdfAnalysisConfig = require('../config/pdf-analysis-api');
const dasExtractionConfig = require('../config/das-extraction-api');
const softciteConfig = require('../config/softcite-api');
const grobidConfig = require('../config/grobid-api');
const openalexConfig = require('../config/openalex-api');
const orcidApiConfig = require('../config/orcid-api');
const datasetsConfig = require('../config/datasets-detection-api');
const materialsConfig = require('../config/materials-detection-api');
const protocolsConfig = require('../config/protocols-detection-api');
const markdownConfig = require('../config/pdf-markdown-api');
const krtComparisonConfig = require('../config/krt-comparison-api');
const identifierDetectionConfig = require('../config/identifier-detection-api');
const krtGroundingConfig = require('../config/krt-grounding-api');
const softwareLmConfig = require('../config/software-detection-lm-api');
const { buildPipelineGraph } = require('../services/queue/pipeline-graph.service');

const router = express.Router();

/**
 * GET /api/config/krt-template
 * Returns the KRT template URL (Google Sheets).
 * The value is env/admin-configured and the frontend binds it straight to
 * href attributes, so only http(s) URLs leave the server — a stored
 * `javascript:` URL would otherwise become clickable XSS in every consumer.
 */
/**
 * Only `/environment` is public.
 *
 * It carries the signup flag the login page needs before a user exists. The
 * rest describe the deployment — which integrations hold keys, which run on
 * demo data, the whole job graph — which is a free map of the backend for
 * anyone who finds the host. Every one of them is consumed after login
 * (verified against the frontend: the process panel, the pipeline pages and
 * the KRT template link).
 */
router.get('/krt-template', authenticate, (req, res) => {
  const url = /^https?:\/\//i.test(KRT_TEMPLATE_URL) ? KRT_TEMPLATE_URL : '';
  res.json({ url });
});

/**
 * GET /api/config/source
 *
 * Where this deployment's code lives, so the UI can link a result to the prompt
 * that produced it.
 *
 * The branch follows the environment because that is how the deployments are
 * built: production runs what is on main, everything else runs dev. Both are
 * overridable, since a deployment that tracks neither should not link readers
 * to code it is not running.
 */
router.get('/source', authenticate, (req, res) => {
  const repoUrl = (process.env.SOURCE_REPO_URL || 'https://github.com/DataSeer/asap-kr-sync')
    .replace(/\/+$/, '');
  const branch = process.env.SOURCE_BRANCH
    || (process.env.NODE_ENV === 'production' ? 'main' : 'dev');
  res.json({ repoUrl, branch });
});

/**
 * GET /api/config/pipeline
 *
 * The processing pipeline as a graph: which steps exist, what each waits for,
 * which stage it sits in, and whether it can pause for input.
 *
 * Served rather than mirrored in the client because the client had been
 * mirroring it, twice, and the two copies had already drifted apart from the
 * table that actually runs — one claimed PDF Analysis waits for seven steps,
 * the other for two, and the truth is seven.
 *
 * Static for a given deployment, so it is cacheable and carries no submission
 * data.
 */
router.get('/pipeline', authenticate, (req, res) => {
  res.json(buildPipelineGraph());
});

/**
 * GET /api/config/detection-pipelines
 *
 * The named detection configurations a submission can be analysed with —
 * `seeded-v1`, `blind-v1` and whatever else `config/pipelines.js` grows.
 *
 * NOT the same thing as `/api/config/pipeline` above, which is the twelve-step
 * job graph. The two senses of "pipeline" predate each other; this one is
 * spelled out to keep them apart at the call site.
 *
 * `adminOnly` arms are withheld from anyone who cannot choose them, so the
 * listing matches what `POST /submissions` will actually accept — a selector
 * offering an option the server refuses is the mismatch this whole audit was
 * about. The strategies, merge and grounding policies are not sent: they are
 * implementation, and no client decides anything from them.
 */
router.get('/detection-pipelines', authenticate, (req, res) => {
  const isAdmin = req.user?.role === ROLES.ADMIN;
  const pipelines = Object.values(PIPELINES)
    .filter((p) => !p.adminOnly || isAdmin)
    .map(({ id, label, description, isDefault, adminOnly }) =>
      ({ id, label, description, isDefault: !!isDefault, adminOnly: !!adminOnly }));
  res.json({ pipelines, defaultPipelineId: DEFAULT_PIPELINE_ID });
});

/**
 * GET /api/config/resource-types
 * Returns the list of valid resource types for KRT
 */
router.get('/resource-types', authenticate, async (req, res, next) => {
  try {
    const resourceTypes = await getResourceTypes();
    res.json({ resourceTypes });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/config/environment
 * Returns the current environment label and public auth flags.
 * `signupEnabled` mirrors the `SIGNUP_ENABLED` env var (defaults to false)
 * and controls whether self-service account creation is exposed in the UI.
 */
router.get('/environment', (req, res) => {
  res.json({
    environment: process.env.NODE_ENV || 'development',
    signupEnabled: process.env.SIGNUP_ENABLED === 'true'
  });
});

/**
 * GET /api/config/services
 * Returns the live config state of each pipeline step so the panel can
 * render the "On / Demo / Off" pill before any job has run.
 *
 * Each entry includes:
 *   - state:        'on' | 'demo' | 'off'  (the canonical config badge)
 *   - enabled:      raw external-service flag
 *   - hasDemoData:  raw demo flag
 * Plus optional subServices (orcid only).
 */
router.get('/services', authenticate, (req, res) => {
  const { configState } = require('../services/demo-fallback.service');
  const entry = (isExternalEnabled, demoEnabled, extra = {}) => ({
    state: configState({ isExternalEnabled, demoEnabled }),
    enabled: isExternalEnabled,
    hasDemoData: demoEnabled,
    ...extra
  });

  res.json({
    services: {
      das_extraction: entry(
        dasExtractionConfig.isConfigured(),
        process.env.DAS_EXTRACTION_DEMO_DATA_ENABLED !== 'false'
      ),
      pdf_analysis: entry(
        pdfAnalysisConfig.isConfigured(),
        process.env.PDF_ANALYSIS_DEMO_DATA_ENABLED === 'true'
      ),
      software_detection: entry(
        softciteConfig.isConfigured(),
        process.env.SOFTWARE_DETECTION_DEMO_DATA_ENABLED !== 'false',
        {
          subServices: {
            softcite: { enabled: softciteConfig.isConfigured() },
            lm_pass: { enabled: softwareLmConfig.isConfigured() }
          }
        }
      ),
      orcid_extraction: entry(
        grobidConfig.isConfigured(),
        process.env.ORCID_EXTRACTION_DEMO_DATA_ENABLED === 'true',
        {
          subServices: {
            grobid: { enabled: grobidConfig.isConfigured() },
            openalex: { enabled: openalexConfig.isConfigured() },
            orcid_api: { enabled: orcidApiConfig.isConfigured() }
          }
        }
      ),
      markdown_convert: entry(
        markdownConfig.isConfigured(),
        process.env.PDF_MARKDOWN_DEMO_DATA_ENABLED !== 'false'
      ),
      datasets_detection: entry(
        datasetsConfig.isConfigured(),
        process.env.DATASETS_DETECTION_DEMO_DATA_ENABLED !== 'false'
      ),
      materials_detection: entry(
        materialsConfig.isConfigured(),
        process.env.MATERIALS_DETECTION_DEMO_DATA_ENABLED !== 'false'
      ),
      protocols_detection: entry(
        protocolsConfig.isConfigured(),
        process.env.PROTOCOLS_DETECTION_DEMO_DATA_ENABLED !== 'false'
      ),
      // Local scan — no external API and no demo path, so it is On whenever the
      // module is not explicitly disabled. Without this entry the panel had no
      // live state to read and showed "Off" until the job had run once and
      // persisted its own snapshot.
      identifier_detection: entry(
        identifierDetectionConfig.isEnabled(),
        false
      ),
      // The deterministic matcher always runs, so the module is always On; the
      // LM second look is an optional enhancement, reported as a sub-service.
      krt_grounding: entry(
        true,
        false,
        {
          subServices: {
            second_look: { enabled: krtGroundingConfig.isConfigured() }
          }
        }
      ),
      // LM-only (no demo path): on when the KRT comparison API is configured.
      suggestion_generation: entry(
        krtComparisonConfig.isConfigured(),
        false
      )
    }
  });
});

module.exports = router;
