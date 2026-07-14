/**
 * Submissions Controller
 */

const { Op } = require('sequelize');
const { Submission, User, ChangeLog, UserHiddenSubmission, File, KRTData, sequelize } = require('../models');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { extractProjectFromManuscriptId, parsePagination, buildPaginationMeta, statusToStep, buildS3Folder } = require('../utils/helpers');
const s3Service = require('../services/storage/s3.service');
const parserService = require('../services/krt/parser.service');
const krtService = require('../services/krt/krt.service');
const { KRT_COLUMNS } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * List submissions (filtered by role)
 * GET /api/submissions
 *
 * Query params:
 * - status: comma-separated list of statuses (e.g., "draft,step1,step2")
 * - project: comma-separated list of project (grant) codes (e.g., "WH,ML")
 * - userId: comma-separated list of user IDs (e.g., "1,2,3")
 * - page, limit: pagination
 * - sort, order: sorting
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const filter = req.submissionFilter || {};
    const visibility = req.query.visibility || 'visible'; // 'visible' | 'hidden' | 'all'

    // Add optional status filter (supports comma-separated values)
    if (req.query.status) {
      const statuses = req.query.status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        filter.status = statuses[0];
      } else if (statuses.length > 1) {
        filter.status = { [Op.in]: statuses };
      }
    }

    // Add optional project filter (supports comma-separated values). This is
    // the "filter for clarity" dimension — it only narrows the role-scoped set.
    if (req.query.project && !filter.project) {
      const projects = req.query.project.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
      if (projects.length === 1) {
        filter.project = projects[0];
      } else if (projects.length > 1) {
        filter.project = { [Op.in]: projects };
      }
    }

    // Optional structured title filter (filters section). Single column, and
    // debounced client-side, so the cost is bounded.
    if (req.query.title && req.query.title.trim()) {
      filter[Op.and] = [
        ...(filter[Op.and] || []),
        { title: { [Op.iLike]: `%${req.query.title.trim()}%` } }
      ];
    }

    // Add optional userId filter (supports comma-separated values).
    // User IDs are UUIDs — keep them as strings. parseInt would turn every
    // UUID into NaN and silently drop the filter, returning all submissions.
    // `!filter.userId` mirrors the team guard: never let a query param widen
    // an author's role-scoped own-submissions restriction.
    if (req.query.userId && !filter.userId) {
      const userIds = req.query.userId.split(',').map(id => id.trim()).filter(Boolean);
      if (userIds.length === 1) {
        filter.userId = userIds[0];
      } else if (userIds.length > 1) {
        filter.userId = { [Op.in]: userIds };
      }
    }

    // Apply visibility filter based on user's hidden submissions
    if (visibility !== 'all') {
      const hiddenSubmissions = await UserHiddenSubmission.findAll({
        where: { userId: req.userId },
        attributes: ['submissionId']
      });
      const hiddenIds = hiddenSubmissions.map(h => h.submissionId);

      if (hiddenIds.length > 0) {
        if (visibility === 'hidden') {
          filter.id = { ...(filter.id || {}), [Op.in]: hiddenIds };
        } else {
          filter.id = { ...(filter.id || {}), [Op.notIn]: hiddenIds };
        }
      } else if (visibility === 'hidden') {
        // No hidden submissions exist — return empty result
        return res.json({
          submissions: [],
          pagination: buildPaginationMeta(0, page, limit)
        });
      }
    }

    // Allowlist sort column/direction here. The pagination Joi schema also
    // validates these, but it writes to req.validatedQuery while this handler
    // reads req.query — so re-assert the allowlist to avoid ordering by an
    // arbitrary/hidden column (and the error-based 500s that come with it).
    const SORTABLE_COLUMNS = ['createdAt', 'updatedAt', 'title', 'status'];
    const sortColumn = SORTABLE_COLUMNS.includes(req.query.sort) ? req.query.sort : 'createdAt';
    const sortOrder = req.query.order === 'ASC' ? 'ASC' : 'DESC';

    const { count, rows } = await Submission.findAndCountAll({
      where: filter,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      }],
      order: [[sortColumn, sortOrder]],
      limit,
      offset
    });

    res.json({
      submissions: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create submission. Accepts multipart/form-data with metadata fields and a
 * required KRT file ("krt"). The KRT format is validated **before** any DB
 * writes — if the file isn't a properly-formatted Key Resources Table, the
 * endpoint returns 400 and no submission row is created. This enforces the
 * "no orphan submissions" invariant on the server so the create flow can't
 * be bypassed by skipping the frontend's pre-flight check.
 *
 * POST /api/submissions
 */
async function create(req, res, next) {
  try {
    const { title, dataAvailabilityStatement, manuscriptId, notes } = req.validatedBody;

    // 1. KRT file is required — frontend always attaches it.
    if (!req.file) {
      throw new ValidationError('A Key Resources Table file is required to create a submission.');
    }

    // 2. Parse the file. Parser errors (bad CSV / unsupported format) come
    //    out as ValidationError already; we surface them as 400.
    let parsedRows;
    try {
      parsedRows = await parserService.parseFile(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
    } catch (err) {
      return res.status(400).json({
        valid: false,
        error: err.message,
        missingColumns: KRT_COLUMNS
      });
    }

    // 3. Column header check. If the headers aren't on row 1 (or any
    //    required column is missing), reject — no DB writes yet.
    const columnCheck = parserService.validateColumns(parsedRows);
    if (!columnCheck.valid) {
      return res.status(400).json({
        valid: false,
        error: 'Ensure the first row of the Key Resources Table includes the correct values.',
        missingColumns: columnCheck.missingColumns
      });
    }

    // 4. Validation passed — create the submission, then persist the KRT.
    //    If KRT persistence fails after submission creation (S3 outage,
    //    DB error), we clean up the submission so the user doesn't see an
    //    orphan record on the dashboard.
    const project = manuscriptId ? await extractProjectFromManuscriptId(manuscriptId) : null;

    // The KRT is uploaded as part of create now, so the submission is
    // already past the 'draft' phase (which historically meant "no files
    // yet"). Start at 'step_krt' so the KRT view's `status !== 'draft'`
    // gate lets the row fetch run.
    const submission = await Submission.create({
      userId: req.userId,
      title,
      dataAvailabilityStatement,
      manuscriptId: manuscriptId || null,
      project,
      notes,
      status: 'step_krt'
    });

    // uploadAndProcess runs its own internal transaction; it can't join an
    // outer one (it re-reads the submission row on a separate connection), so
    // creation is compensated rather than transactional: any failure after
    // Submission.create destroys the submission, and the FK cascades remove
    // whatever children (files, KRT rows, change logs) were committed. The
    // S3 object is intentionally left behind — uploadAndProcess documents
    // orphaned keys as harmless and cleaned up by lifecycle rules.
    try {
      await krtService.uploadAndProcess(submission.id, req.file, req.userId, 1);

      // Log the creation
      await ChangeLog.create({
        submissionId: submission.id,
        userId: req.userId,
        action: 'upload',
        step: 1,
        round: 1,
        description: 'Submission created with Key Resources Table'
      });
    } catch (creationErr) {
      // Roll back the submission so the user can retry cleanly. We catch
      // and log the destroy failure separately — losing the cleanup is
      // worse than the original error, so don't mask it.
      try {
        await Submission.destroy({ where: { id: submission.id } });
      } catch (cleanupErr) {
        logger.error('Failed to clean up submission after creation error', {
          submissionId: submission.id,
          cleanupError: cleanupErr.message
        });
      }
      throw creationErr;
    }

    logger.info('Submission created with KRT', {
      submissionId: submission.id,
      userId: req.userId,
      krtRows: parsedRows.length
    });

    res.status(201).json({ submission });
  } catch (error) {
    next(error);
  }
}

/**
 * Get submission by ID
 * GET /api/submissions/:id
 */
async function getById(req, res, next) {
  try {
    // Always fetch fresh with includes
    const submission = await Submission.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email']
        },
        {
          model: File,
          as: 'files',
          attributes: ['id', 'type', 'fileName', 's3Key', 'mimeType', 'size', 'version', 'round', 'createdAt'],
          order: [['version', 'DESC']]
        }
      ]
    });

    if (!submission) {
      throw new NotFoundError('Submission');
    }

    // Get latest file for each type (filtered by current round) and generate pre-signed URLs
    const latestFiles = {};
    const currentRound = submission.currentRound || 1;
    if (submission.files) {
      for (const file of submission.files) {
        // Treat null/undefined round as round 1 for backward compatibility
        const fileRound = file.round || 1;
        if (fileRound !== currentRound) continue;
        if (!latestFiles[file.type] || file.version > latestFiles[file.type].version) {
          // Generate pre-signed URL for download (valid for 1 hour)
          let presignedUrl = null;
          try {
            if (file.s3Key) {
              presignedUrl = await s3Service.getPresignedDownloadUrl(file.s3Key, 3600);
            }
          } catch (err) {
            logger.warn('Failed to generate presigned URL', { fileId: file.id, error: err.message });
          }

          latestFiles[file.type] = {
            id: file.id,
            type: file.type,
            fileName: file.fileName,
            s3Url: presignedUrl || null,
            mimeType: file.mimeType,
            size: file.size,
            version: file.version,
            createdAt: file.createdAt
          };
        }
      }
    }

    res.json({
      submission,
      latestFiles
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update submission
 * PATCH /api/submissions/:id
 */
async function update(req, res, next) {
  try {
    const submission = req.submission;
    const { title, dataAvailabilityStatement, manuscriptId, notes, status } = req.validatedBody;

    if (title) submission.title = title;
    if (dataAvailabilityStatement !== undefined) submission.dataAvailabilityStatement = dataAvailabilityStatement;
    if (manuscriptId !== undefined) {
      submission.manuscriptId = manuscriptId || null;
      // Re-derive the project (grant) code if the manuscript ID changed.
      submission.project = manuscriptId ? await extractProjectFromManuscriptId(manuscriptId) : submission.project;
    }
    if (notes !== undefined) submission.notes = notes;

    let statusChanged = false;
    if (status) {
      // Allow staying in the same status (no-op)
      if (status !== submission.status) {
        if (!submission.canTransitionTo(status)) {
          logger.warn('Invalid status transition', {
            currentStatus: submission.status,
            newStatus: status
          });
          return res.status(400).json({
            error: `Cannot transition from ${submission.status} to ${status}`
          });
        }
        submission.status = status;
        statusChanged = true;
      }
    }

    await submission.save();

    // Pipeline steps can gate on submission state (e.g. the seeded detectors
    // wait for the KRT step to be validated), so a status change may unblock
    // waiting jobs. Failure here is non-fatal: the periodic reconciler
    // re-drives gated jobs within one sweep interval.
    if (statusChanged) {
      try {
        const orchestrator = require('../services/queue/orchestrator.service');
        await orchestrator.reconcileSubmission(submission.id, submission.currentRound, req.userId);
      } catch (advanceErr) {
        logger.error('Failed to re-drive pipeline after status change', {
          submissionId: submission.id,
          status: submission.status,
          error: advanceErr.message
        });
      }
    }

    logger.info('Submission updated', { submissionId: submission.id, userId: req.userId });

    res.json({ submission });
  } catch (error) {
    next(error);
  }
}

/**
 * Reassign a submission to another owner (staff only).
 *
 * Staff (admin / ds_annotator) upload and curate documents for testing, then
 * hand them to the real user. Visibility follows the owner's teams, so simply
 * changing the owner makes the document visible to that user and their
 * teammates.
 *
 * PATCH /api/submissions/:id/owner  { userId }
 */
async function reassignOwner(req, res, next) {
  try {
    const submission = req.submission; // loaded + access-checked by middleware
    const { userId: newOwnerId } = req.validatedBody;

    if (newOwnerId === submission.userId) {
      return res.status(400).json({ error: 'Submission already belongs to this user' });
    }

    const newOwner = await User.findByPk(newOwnerId, { attributes: ['id', 'name', 'email'] });
    if (!newOwner) {
      throw new NotFoundError('User');
    }

    const previousOwnerId = submission.userId;
    submission.userId = newOwnerId;
    await submission.save();

    await ChangeLog.create({
      submissionId: submission.id,
      userId: req.userId,
      action: 'edit',
      description: `Owner reassigned to ${newOwner.email}`
    });

    logger.info('Submission owner reassigned', {
      submissionId: submission.id,
      previousOwnerId,
      newOwnerId,
      reassignedBy: req.userId
    });

    res.json({
      submission,
      user: { id: newOwner.id, name: newOwner.name, email: newOwner.email }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete submission
 * DELETE /api/submissions/:id
 */
async function deleteSubmission(req, res, next) {
  try {
    const submission = await Submission.findByPk(req.params.id);
    if (!submission) {
      throw new NotFoundError('Submission');
    }

    // Delete the entire S3 folder for this submission first (best-effort).
    // Every file the submission ever produced — uploaded KRT/PDF, generated
    // reports, job raw responses, logs — lives under a single
    // {manuscriptId}_{submissionId}/ prefix, so a single prefix delete cleans
    // up everything. We log but don't fail the DB delete if S3 has issues —
    // a stranded folder is recoverable, a half-deleted DB row is not.
    const s3Folder = buildS3Folder(submission.manuscriptId, submission.id);
    let s3DeletedCount = 0;
    try {
      s3DeletedCount = await s3Service.deletePrefix(`${s3Folder}/`);
    } catch (s3Error) {
      logger.error('S3 cleanup failed during submission delete', {
        submissionId: submission.id,
        s3Folder,
        error: s3Error.message
      });
    }

    await submission.destroy();

    logger.info('Submission deleted', {
      submissionId: req.params.id,
      userId: req.userId,
      s3ObjectsDeleted: s3DeletedCount
    });

    res.json({ message: 'Submission deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Get change history
 * GET /api/submissions/:id/changes
 */
async function getChanges(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);

    const { count, rows } = await ChangeLog.getHistory(req.params.id, { limit, offset });

    res.json({
      changes: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Hide submission for current user
 * POST /api/submissions/:id/hide
 */
async function hideSubmission(req, res, next) {
  try {
    const submissionId = req.params.id;

    // Check if submission exists
    const submission = await Submission.findByPk(submissionId);
    if (!submission) {
      throw new NotFoundError('Submission');
    }

    // Check if already hidden
    const existing = await UserHiddenSubmission.findOne({
      where: { userId: req.userId, submissionId }
    });

    if (!existing) {
      await UserHiddenSubmission.create({
        userId: req.userId,
        submissionId
      });
    }

    logger.info('Submission hidden', { submissionId, userId: req.userId });

    res.json({ message: 'Submission hidden successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Unhide submission for current user
 * POST /api/submissions/:id/unhide
 */
async function unhideSubmission(req, res, next) {
  try {
    const submissionId = req.params.id;

    await UserHiddenSubmission.destroy({
      where: { userId: req.userId, submissionId }
    });

    logger.info('Submission unhidden', { submissionId, userId: req.userId });

    res.json({ message: 'Submission unhidden successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Get hidden submissions for current user
 * GET /api/submissions/hidden
 */
async function listHidden(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);

    // Get hidden submission IDs for this user
    const hiddenSubmissions = await UserHiddenSubmission.findAll({
      where: { userId: req.userId },
      attributes: ['submissionId']
    });
    const hiddenIds = hiddenSubmissions.map(h => h.submissionId);

    if (hiddenIds.length === 0) {
      return res.json({
        submissions: [],
        pagination: buildPaginationMeta(0, page, limit)
      });
    }

    // Apply user's submission filter (role-based access)
    const filter = req.submissionFilter || {};
    filter.id = { [Op.in]: hiddenIds };

    const { count, rows } = await Submission.findAndCountAll({
      where: filter,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      }],
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    res.json({
      submissions: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get filter options (distinct projects and users with submissions)
 * GET /api/submissions/filter-options
 */
async function getFilterOptions(req, res, next) {
  try {
    const filter = req.submissionFilter || {};

    // Get distinct projects from submissions the user can access
    const projectsResult = await Submission.findAll({
      where: { ...filter, project: { [Op.not]: null } },
      attributes: [[Submission.sequelize.fn('DISTINCT', Submission.sequelize.col('project')), 'project']],
      raw: true
    });
    const projects = projectsResult.map(r => r.project).filter(Boolean).sort();

    // Get users who have submissions the user can access
    const usersResult = await User.findAll({
      attributes: ['id', 'name', 'email'],
      include: [{
        model: Submission,
        as: 'submissions',
        where: filter,
        attributes: [],
        required: true
      }],
      group: ['User.id'],
      order: [['name', 'ASC']]
    });

    res.json({
      projects,
      users: usersResult.map(u => ({ id: u.id, name: u.name, email: u.email }))
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Download file (generates presigned URL)
 * GET /api/submissions/:id/files/:fileId/download
 */
async function downloadFile(req, res, next) {
  try {
    const { id: submissionId, fileId } = req.params;

    // Find the file
    const file = await File.findOne({
      where: {
        id: fileId,
        submissionId
      }
    });

    if (!file) {
      throw new NotFoundError('File');
    }

    // Generate presigned URL (1 hour expiry)
    const presignedUrl = await s3Service.getPresignedDownloadUrl(file.s3Key, 3600);

    logger.info('File download URL generated', {
      fileId: file.id,
      submissionId
    });

    res.json({ url: presignedUrl });
  } catch (error) {
    next(error);
  }
}

/**
 * Process new version (start a new round)
 * POST /api/submissions/:id/new-round
 */
async function processNewVersion(req, res, next) {
  try {
    const { hasNewKRT } = req.validatedBody;
    const submission = req.submission;

    // Verify submission is at step_report or completed
    if (!['step_report', 'completed'].includes(submission.status)) {
      throw new ValidationError('Must be at report step or completed to start a new round');
    }

    const result = await sequelize.transaction(async (t) => {
      const previousRound = submission.currentRound;
      const newRound = previousRound + 1;

      // Update submission — clear DAS fields so they get re-extracted from the new PDF.
      // Status always lands on step_krt: the NewRoundModal collects the new PDF up
      // front and the frontend uploads it immediately after this call, so by the
      // time the user lands on Step 2 (KRT) the PDF is already in flight. If a
      // legacy caller skips the PDF upload step they can still replace the PDF
      // via the "Replace PDF" fallback button on Step 2.
      submission.currentRound = newRound;
      submission.dataAvailabilityStatement = null;
      submission.extractedDataAvailabilityStatement = null;
      submission.status = 'step_krt';
      await submission.save({ transaction: t });

      // If no new KRT, copy all KRT rows and file from previous round
      if (!hasNewKRT) {
        // Copy KRT data rows
        const previousRows = await KRTData.findAll({
          where: { submissionId: submission.id, round: previousRound },
          order: [['createdAt', 'ASC']],
          transaction: t
        });

        // Single bulkCreate instead of per-row inserts — large KRTs held the
        // transaction open for dozens of sequential round-trips.
        await KRTData.bulkCreate(
          previousRows.map(row => ({
            submissionId: submission.id,
            resourceType: row.resourceType,
            resourceName: row.resourceName,
            source: row.source,
            identifier: row.identifier,
            newReuse: row.newReuse,
            additionalInformation: row.additionalInformation,
            parsedIdentifiers: row.parsedIdentifiers,
            round: newRound,
            originRowId: row.id
          })),
          { transaction: t }
        );

        // Copy the latest KRT file record to the new round
        const latestKrtFile = await File.findOne({
          where: { submissionId: submission.id, type: 'krt', round: previousRound },
          order: [['version', 'DESC']],
          transaction: t
        });

        if (latestKrtFile) {
          // `version` is per-(submission, type, round). The carry-forward is
          // the first KRT row in newRound, so this lookup is just defensive —
          // it'll normally be null and nextVersion lands at 1.
          const maxVersionResult = await File.max('version', {
            where: { submissionId: submission.id, type: 'krt', round: newRound },
            transaction: t
          });
          const nextVersion = (maxVersionResult || 0) + 1;

          await File.create({
            submissionId: submission.id,
            type: 'krt',
            fileName: latestKrtFile.fileName,
            s3Key: latestKrtFile.s3Key,
            mimeType: latestKrtFile.mimeType,
            size: latestKrtFile.size,
            version: nextVersion,
            round: newRound
          }, { transaction: t });
        }
      }

      // Carry supplemental PDF forward to the new round (if one exists)
      const latestSupplemental = await File.findOne({
        where: { submissionId: submission.id, type: 'supplemental_pdf', round: previousRound },
        order: [['version', 'DESC']],
        transaction: t
      });

      if (latestSupplemental) {
        // Also carry forward the original supplemental file
        const latestSuppOriginal = await File.findOne({
          where: { submissionId: submission.id, type: 'supplemental', round: previousRound },
          order: [['version', 'DESC']],
          transaction: t
        });

        if (latestSuppOriginal) {
          const suppOrigMaxVersion = await File.max('version', {
            where: { submissionId: submission.id, type: 'supplemental', round: newRound },
            transaction: t
          });
          await File.create({
            submissionId: submission.id,
            type: 'supplemental',
            fileName: latestSuppOriginal.fileName,
            s3Key: latestSuppOriginal.s3Key,
            mimeType: latestSuppOriginal.mimeType,
            size: latestSuppOriginal.size,
            version: (suppOrigMaxVersion || 0) + 1,
            round: newRound
          }, { transaction: t });
        }

        const suppPdfMaxVersion = await File.max('version', {
          where: { submissionId: submission.id, type: 'supplemental_pdf', round: newRound },
          transaction: t
        });
        await File.create({
          submissionId: submission.id,
          type: 'supplemental_pdf',
          fileName: latestSupplemental.fileName,
          s3Key: latestSupplemental.s3Key,
          mimeType: latestSupplemental.mimeType,
          size: latestSupplemental.size,
          version: (suppPdfMaxVersion || 0) + 1,
          round: newRound
        }, { transaction: t });
      }

      // Log the new round
      await ChangeLog.create({
        submissionId: submission.id,
        userId: req.userId,
        action: 'new_round',
        step: statusToStep(submission.status),
        round: newRound,
        description: `Started round ${newRound}${hasNewKRT ? ' with new KRT' : ' (KRT carried forward)'}`
      }, { transaction: t });

      return { submission, newRound };
    });

    logger.info('New round started', {
      submissionId: submission.id,
      round: result.newRound,
      hasNewKRT,
      userId: req.userId
    });

    res.json({ submission: result.submission });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  create,
  getById,
  update,
  reassignOwner,
  delete: deleteSubmission,
  getChanges,
  hideSubmission,
  unhideSubmission,
  listHidden,
  getFilterOptions,
  downloadFile,
  processNewVersion
};
