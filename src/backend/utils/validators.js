/**
 * Custom Validators
 */

const Joi = require('joi');
const { ROLES, SUBMISSION_STATUSES, REPORT_TYPES, CHANGE_SOURCES } = require('../config/constants');

// Cache for dynamic schemas
let dynamicSchemaCache = {
  teams: null,
  resourceTypes: null,
  lastUpdate: null
};

// Common Joi schemas (static ones)
const schemas = {
  // UUID validation
  uuid: Joi.string().uuid({ version: 'uuidv4' }),

  // Email validation
  email: Joi.string().email().lowercase().trim().max(255),

  // Password validation (min 8 chars, at least 1 letter and 1 number)
  password: Joi.string()
    .min(8)
    .max(128)
    .pattern(/^(?=.*[A-Za-z])(?=.*\d)/)
    .messages({
      'string.pattern.base': 'Password must contain at least one letter and one number'
    }),

  // Role validation
  role: Joi.string().valid(...Object.values(ROLES)),

  // Project (grant) code — 2 letters, uppercased. Filter dimension only.
  project: Joi.string().uppercase(),

  // Team name (lab leader), e.g. "Alessi", "Reck-Peterson". Not uppercased.
  teamName: Joi.string().trim().min(1).max(100),

  // Manuscript ID validation - strict format: XX#-######-###-org-X-#
  // Example: XX1-000000-001-org-X-1
  // Format: [2-letter team code][digit]-[6 digits]-[3 digits]-org-[letter]-[digit]
  // Case-insensitive: lowercase input is auto-uppercased by .uppercase()
  manuscriptId: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z]{2}\d-\d{6}-\d{3}-org-[A-Z]-\d$/i)
    .max(100)
    .messages({
      'string.pattern.base': 'Manuscript ID must follow format: XX#-######-###-org-X-# (e.g., XX1-000000-001-org-X-1)'
    }),

  // Submission status validation
  submissionStatus: Joi.string().valid(...SUBMISSION_STATUSES),

  // Resource type validation - dynamic, use getDynamicSchemas().resourceType
  resourceType: Joi.string(),

  // NEW/REUSE validation
  newReuse: Joi.string().valid('new', 'reuse').lowercase()
};

/**
 * Get dynamic Joi schemas that depend on database values
 * @returns {Promise<object>} { team, resourceType }
 */
async function getDynamicSchemas() {
  const { getProjects, getTeams, getResourceTypes } = require('../config/constants');

  const [projects, teams, resourceTypes] = await Promise.all([
    getProjects(),
    getTeams(),
    getResourceTypes()
  ]);

  return {
    project: Joi.string().valid(...projects).uppercase(),
    team: Joi.string().valid(...teams),
    resourceType: Joi.string().valid(...resourceTypes)
  };
}

/**
 * Invalidate schema cache
 */
function invalidateSchemaCache() {
  dynamicSchemaCache = {
    teams: null,
    resourceTypes: null,
    lastUpdate: null
  };
}

// Request validation schemas
const requestSchemas = {
  // Auth
  register: Joi.object({
    email: schemas.email.required(),
    password: schemas.password.required(),
    name: Joi.string().trim().min(2).max(100).required()
    // NOTE: `role` and `team` are intentionally NOT accepted on self-signup.
    // Any client-supplied values are dropped by stripUnknown, and the role is
    // forced to 'author' in auth.service.register(). This prevents privilege
    // escalation via the public register endpoint. Roles/teams are assigned
    // only through the admin user-management endpoints (createUser/updateUser).
  }),

  login: Joi.object({
    email: schemas.email.required(),
    password: Joi.string().required()
  }),

  // Submissions
  createSubmission: Joi.object({
    title: Joi.string().trim().min(1).max(500).required(),
    dataAvailabilityStatement: Joi.string().trim().max(5000).allow('', null),
    manuscriptId: schemas.manuscriptId.allow('', null),
    notes: Joi.string().trim().max(2000).allow('')
  }),

  updateSubmission: Joi.object({
    title: Joi.string().trim().min(1).max(500),
    dataAvailabilityStatement: Joi.string().trim().max(5000).allow('', null),
    manuscriptId: schemas.manuscriptId.allow('', null),
    notes: Joi.string().trim().max(2000).allow('', null),
    status: schemas.submissionStatus
  }),

  // Staff-only: hand a submission to another user (see reassignOwner controller).
  reassignOwner: Joi.object({
    userId: schemas.uuid.required()
  }),

  // KRT row
  // KRT row - all fields optional to allow adding incomplete rows
  // Validation errors will be shown in UI via KRT validation system
  krtRow: Joi.object({
    resourceType: schemas.resourceType.allow('', null),
    resourceName: Joi.string().trim().max(500).allow('', null),
    source: Joi.string().trim().max(5000).allow('', null),
    identifier: Joi.string().trim().max(500).allow('', null),
    newReuse: schemas.newReuse.allow('', null),
    additionalInformation: Joi.string().trim().max(2000).allow('', null)
  }),

  // `column` is a strict allowlist: the controller maps it to a model field, and
  // an unlisted value must be rejected here — falling through to the raw string
  // would let clients write arbitrary attributes (submissionId, round, ...).
  // is_qc/is_optional are role-gated in the controller and take booleans.
  updateKrtCell: Joi.object({
    column: Joi.string().valid(
      'resource_type', 'resource_name', 'source',
      'identifier', 'new_reuse', 'additional_information',
      'is_qc', 'is_optional'
    ).required(),
    value: Joi.alternatives().try(
      Joi.string().allow('', null),
      Joi.boolean(),
      Joi.number()
    ).required(),
    source: Joi.string().valid(...CHANGE_SOURCES)
  }),

  // Batch variant: one user gesture (bulk-apply fixes, multi-cell edit) = one
  // request instead of a per-cell request storm. Same column allowlist as
  // updateKrtCell; `source` applies to every item's ChangeLog entry. The item
  // cap bounds the work a single request can queue (body limit is 10mb, so
  // without a cap one request could carry an arbitrary number of writes).
  batchUpdateKrtCells: Joi.object({
    updates: Joi.array().items(Joi.object({
      rowId: schemas.uuid.required(),
      column: Joi.string().valid(
        'resource_type', 'resource_name', 'source',
        'identifier', 'new_reuse', 'additional_information',
        'is_qc', 'is_optional'
      ).required(),
      value: Joi.alternatives().try(
        Joi.string().allow('', null),
        Joi.boolean(),
        Joi.number()
      ).required()
    })).min(1).max(500).required(),
    source: Joi.string().valid(...CHANGE_SOURCES)
  }),

  // Process new version (new round)
  processNewVersion: Joi.object({
    hasNewKRT: Joi.boolean().required()
  }),

  // Pagination query
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sort: Joi.string().valid('createdAt', 'updatedAt', 'title', 'status').default('createdAt'),
    order: Joi.string().valid('ASC', 'DESC').default('DESC'),
    status: schemas.submissionStatus,
    project: schemas.project,
    title: Joi.string().trim().max(200).allow('')
  }),

  // ── Admin: user management ────────────────────────────────────────
  createUser: Joi.object({
    email: schemas.email.required(),
    password: schemas.password.required(),
    name: Joi.string().trim().min(2).max(100).required(),
    role: schemas.role.required(),
    teams: Joi.array().items(schemas.teamName).max(50).default([])
  }),

  updateUser: Joi.object({
    name: Joi.string().trim().min(2).max(100),
    role: schemas.role,
    password: schemas.password,
    teams: Joi.array().items(schemas.teamName).max(50)
  }).min(1),

  // ── Admin: team management ────────────────────────────────────────
  // A team is a lab identified by its leader's name (stored as `code`).
  createTeam: Joi.object({
    code: Joi.string().trim().min(1).max(100).required(),
    name: Joi.string().trim().max(255).allow('', null)
  }),

  updateTeam: Joi.object({
    code: Joi.string().trim().min(1).max(100),
    name: Joi.string().trim().max(255).allow('', null),
    active: Joi.boolean()
  }).min(1),

  // Bulk import of teams from parsed CSV rows (upsert by code). Rows are
  // validated per-row in the controller, so accept unknown/loose shapes here.
  teamsImport: Joi.object({
    teams: Joi.array().items(Joi.object().unknown(true)).min(1).max(10000).required()
  }),

  // ── Admin: project (grant) management ─────────────────────────────
  // Project code: 2 alphanumeric chars, uppercased (the manuscript prefix).
  createProject: Joi.object({
    code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9]{2}$/).required()
      .messages({ 'string.pattern.base': 'Project code must be exactly 2 letters/digits' }),
    piName: Joi.string().trim().max(255).allow('', null),
    title: Joi.string().trim().max(2000).allow('', null),
    active: Joi.boolean()
  }),

  updateProject: Joi.object({
    piName: Joi.string().trim().max(255).allow('', null),
    title: Joi.string().trim().max(2000).allow('', null),
    active: Joi.boolean()
  }).min(1),

  // Bulk import of projects from parsed CSV rows (upsert by code). Rows are
  // validated per-row in the controller, so accept unknown/loose shapes here.
  projectsImport: Joi.object({
    projects: Joi.array().items(Joi.object().unknown(true)).min(1).max(10000).required()
  }),

  // (team, email) roster used for automatic team assignment. Bulk import of
  // a pasted/CSV list; bounded to keep a single request reasonable. `team` is
  // a team name and must reference an existing team (checked in the controller).
  createTeamEmailMappings: Joi.object({
    mappings: Joi.array().items(Joi.object({
      team: Joi.string().trim().min(1).max(100).required(),
      email: Joi.string().trim().lowercase().email().max(255).required()
    })).min(1).max(2000).required()
  }),

  // ── Profile (self-service) ────────────────────────────────────────
  // newPassword requires currentPassword (verified server-side).
  updateProfile: Joi.object({
    name: Joi.string().trim().min(2).max(100),
    currentPassword: Joi.string().min(1).max(128),
    newPassword: schemas.password
  }).min(1).with('newPassword', 'currentPassword'),

  // ── Admin: app config ─────────────────────────────────────────────
  // value can be any JSON-serialisable shape (string/number/boolean/object/array).
  // Bounded sizes prevent multi-MB blob storage via this endpoint.
  appConfigUpsert: Joi.object({
    key: Joi.string().trim().min(1).max(255).required(),
    value: Joi.alternatives()
      .try(
        Joi.string().max(50000),
        Joi.number(),
        Joi.boolean(),
        Joi.object().unknown(true),
        Joi.array().max(1000)
      )
      .required(),
    description: Joi.string().trim().max(2000).allow('', null),
    category: Joi.string().trim().max(100).allow('', null)
  }),

  // ── Admin: enrichment list ────────────────────────────────────────
  enrichmentListEntry: Joi.object({
    resourceType: Joi.string().trim().max(255).required(),
    resourceName: Joi.string().trim().min(1).max(500).required(),
    source: Joi.string().trim().max(5000).allow('', null),
    identifier: Joi.string().trim().max(500).allow('', null),
    newReuse: Joi.string().valid('new', 'reuse').lowercase().allow('', null),
    additionalInformation: Joi.string().trim().max(5000).allow('', null),
    suggestedEntity: Joi.string().trim().max(500).allow('', null),
    tokens: Joi.array().items(Joi.string().max(500)).max(200).default([])
  }),

  // PATCH semantics: every field optional, but at least one must be present.
  updateEnrichmentListEntry: Joi.object({
    resourceType: Joi.string().trim().max(255),
    resourceName: Joi.string().trim().min(1).max(500),
    source: Joi.string().trim().max(5000).allow('', null),
    identifier: Joi.string().trim().max(500).allow('', null),
    newReuse: Joi.string().valid('new', 'reuse').lowercase().allow('', null),
    additionalInformation: Joi.string().trim().max(5000).allow('', null),
    suggestedEntity: Joi.string().trim().max(500).allow('', null),
    tokens: Joi.array().items(Joi.string().max(500)).max(200)
  }).min(1),

  // Bulk import shape matches the existing controller: { entries, mode, resourceType? }.
  // resourceType is the optional "scoped replace" target — controller uses it to
  // override individual entries' resourceType and to scope the delete in replace mode.
  enrichmentListImport: Joi.object({
    entries: Joi.array().items(Joi.object().unknown(true)).min(1).max(50000).required(),
    mode: Joi.string().valid('append', 'replace').default('append'),
    resourceType: Joi.string().trim().max(255).allow('', null)
  }),

  // ── Submission flow: suggestion approve / reject ──────────────────
  // `overrides` lets the user change one or more fields BEFORE approving an
  // add_row suggestion — for example, picking a different Resource Type than
  // the one the detector suggested. Per-field max lengths match the KRT
  // column caps in seeders/20250101000002-seed-config.js.
  approveSuggestion: Joi.object({
    suggestionId: Joi.string().trim().min(1).max(500).required(),
    modifiedValue: Joi.string().max(5000).allow('', null),
    overrides: Joi.object({
      resourceType: Joi.string().trim().max(255).allow('', null),
      resourceName: Joi.string().trim().max(500).allow('', null),
      source: Joi.string().trim().max(500).allow('', null),
      identifier: Joi.string().trim().max(500).allow('', null),
      newReuse: Joi.string().trim().max(20).allow('', null),
      additionalInformation: Joi.string().max(2000).allow('', null)
    }).optional()
  }),

  rejectSuggestion: Joi.object({
    suggestionId: Joi.string().trim().min(1).max(500).required(),
    reason: Joi.string().trim().max(2000).allow('', null)
  }),

  // Bulk variants — same per-item shapes as the single endpoints, capped to
  // keep request bodies reasonable (UI rarely selects more than a screen full).
  bulkApproveSuggestions: Joi.object({
    items: Joi.array().items(Joi.object({
      suggestionId: Joi.string().trim().min(1).max(500).required(),
      modifiedValue: Joi.string().max(5000).allow('', null),
      overrides: Joi.object({
        resourceType: Joi.string().trim().max(255).allow('', null),
        resourceName: Joi.string().trim().max(500).allow('', null),
        source: Joi.string().trim().max(500).allow('', null),
        identifier: Joi.string().trim().max(500).allow('', null),
        newReuse: Joi.string().trim().max(20).allow('', null),
        additionalInformation: Joi.string().max(2000).allow('', null)
      }).optional()
    })).min(1).max(500).required()
  }),

  bulkRejectSuggestions: Joi.object({
    items: Joi.array().items(Joi.object({
      suggestionId: Joi.string().trim().min(1).max(500).required(),
      reason: Joi.string().trim().max(2000).allow('', null)
    })).min(1).max(500).required()
  }),

  // ── Submission flow: generate report ──────────────────────────────
  generateReport: Joi.object({
    type: Joi.string().valid(...Object.values(REPORT_TYPES)).default('excel')
  })
};

/**
 * Validate request data against schema
 * @param {string} schemaName - Name of the schema to use
 * @param {object} data - Data to validate
 * @returns {object} Validated data
 * @throws {ValidationError} If validation fails
 */
function validate(schemaName, data) {
  const schema = requestSchemas[schemaName];
  if (!schema) {
    throw new Error(`Unknown validation schema: ${schemaName}`);
  }

  const { error, value } = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    const errors = error.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message
    }));
    const { ValidationError } = require('./errors');
    throw new ValidationError('Validation failed', errors);
  }

  return value;
}

module.exports = {
  schemas,
  requestSchemas,
  validate,
  getDynamicSchemas,
  invalidateSchemaCache
};
