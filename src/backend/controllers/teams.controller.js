/**
 * Teams Controller
 */

const { Op } = require('sequelize');
const { Team, UserTeam, TeamEmail, Submission, User } = require('../models');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/errors');
const { parsePagination, buildPaginationMeta } = require('../utils/helpers');
const teamEmailService = require('../services/teams/team-email.service');
const { ROLES } = require('../config/constants');
const { escapeCsvField, stripCsvFormulaGuard } = require('../utils/csv');
const logger = require('../utils/logger');

const CSV_HEADERS = ['code', 'name', 'active'];

/** Parse a CSV "active" cell into a boolean (blank → true, the common default). */
function parseActive(v) {
  if (v == null || String(v).trim() === '') return true;
  return ['true', '1', 'yes', 'y', 'active'].includes(String(v).trim().toLowerCase());
}

/**
 * List all teams
 * GET /api/teams
 */
async function list(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { active } = req.query;

    const whereClause = {};
    if (active !== undefined) {
      whereClause.active = active === 'true';
    }

    const { count, rows } = await Team.findAndCountAll({
      where: whereClause,
      order: [['code', 'ASC']],
      limit,
      offset
    });

    res.json({
      teams: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all active team codes (for dropdowns/validation)
 * GET /api/teams/codes
 */
async function getCodes(req, res, next) {
  try {
    const codes = await Team.getActiveCodes();
    res.json({ codes });
  } catch (error) {
    next(error);
  }
}

/**
 * Get team by ID
 * GET /api/teams/:id
 */
async function getById(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);

    if (!team) {
      throw new NotFoundError('Team');
    }

    // Count users in this team
    const userCount = await UserTeam.count({ where: { team: team.code } });

    res.json({
      team: {
        ...team.toJSON(),
        userCount
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create team
 * POST /api/teams
 */
async function create(req, res, next) {
  try {
    const { code, name } = req.validatedBody;

    // Check if code already exists (Joi already trimmed + uppercased + pattern-checked)
    const existing = await Team.findOne({ where: { code } });
    if (existing) {
      throw new ConflictError('Team code already exists');
    }

    const team = await Team.create({
      code,
      name: name || null,
      active: true
    });

    logger.info('Team created', { teamId: team.id, code: team.code, createdBy: req.userId });

    res.status(201).json({ team });
  } catch (error) {
    next(error);
  }
}

/**
 * Update team
 * PATCH /api/teams/:id
 */
async function update(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);
    if (!team) {
      throw new NotFoundError('Team');
    }

    const { code, name, active } = req.validatedBody;

    // If code is being changed, check for conflicts (Joi already uppercased)
    if (code && code !== team.code) {
      const existing = await Team.findOne({ where: { code } });
      if (existing) {
        throw new ConflictError('Team code already exists');
      }

      // Update user_teams and team_emails references with the new code
      const oldCode = team.code;
      await UserTeam.update(
        { team: code },
        { where: { team: oldCode } }
      );
      await TeamEmail.update(
        { team: code },
        { where: { team: oldCode } }
      );

      team.code = code;
    }

    if (name !== undefined) team.name = name || null;
    if (active !== undefined) team.active = active;

    await team.save();

    logger.info('Team updated', { teamId: team.id, code: team.code, updatedBy: req.userId });

    res.json({ team });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete team
 * DELETE /api/teams/:id
 */
async function deleteTeam(req, res, next) {
  try {
    const team = await Team.findByPk(req.params.id);
    if (!team) {
      throw new NotFoundError('Team');
    }

    // Check if team has users assigned
    const userCount = await UserTeam.count({ where: { team: team.code } });
    if (userCount > 0) {
      return res.status(400).json({
        error: `Cannot delete team with ${userCount} assigned user(s). Remove users first or deactivate the team.`
      });
    }

    // ds_annotator cannot delete a team that still has submissions attached;
    // admins can force-delete.
    if (req.user.role !== ROLES.ADMIN) {
      const submissionCount = await Submission.count({ where: { team: team.code } });
      if (submissionCount > 0) {
        return res.status(400).json({
          error: `Cannot delete team with ${submissionCount} attached submission(s). Reassign them first or ask an admin.`
        });
      }
    }

    await team.destroy();

    logger.info('Team deleted', { teamId: team.id, code: team.code, deletedBy: req.userId });

    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Export all teams as CSV (code, name, active). `code` holds the team key (the
 * lab leader name). The file re-imports cleanly via importCsv.
 * GET /api/teams/export
 */
async function exportCsv(req, res, next) {
  try {
    const teams = await Team.findAll({ order: [['code', 'ASC']], raw: true });
    const rows = [CSV_HEADERS.join(',')];
    for (const t of teams) {
      rows.push([
        escapeCsvField(t.code),
        escapeCsvField(t.name),
        escapeCsvField(t.active ? 'true' : 'false')
      ].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teams.csv"');
    res.send(rows.join('\n'));
  } catch (error) {
    next(error);
  }
}

/**
 * Import (upsert) teams from parsed CSV rows. Each row is matched by `code`
 * (the team key): an existing team has its name/active updated, a new code is
 * created. Blank codes are skipped and reported. The code is the immutable key,
 * so import never renames a team (use the edit form for that).
 * POST /api/teams/import  { teams: [{ code, name, active }] }
 */
async function importCsv(req, res, next) {
  try {
    const { teams } = req.validatedBody;
    let created = 0;
    let updated = 0;
    const invalid = [];

    for (const row of teams) {
      // Accept `code` or its `team` alias (the roster/export uses "Team").
      const code = stripCsvFormulaGuard(String(row.code != null ? row.code : (row.team || ''))).trim();
      if (!code || code.length > 100) {
        invalid.push(row.code || row.team || '(blank)');
        continue;
      }
      const name = (() => {
        const s = row.name == null ? '' : stripCsvFormulaGuard(String(row.name)).trim();
        return s || null;
      })();
      const active = parseActive(row.active);

      const existing = await Team.findOne({ where: { code } });
      if (existing) {
        existing.name = name;
        existing.active = active;
        await existing.save();
        updated++;
      } else {
        await Team.create({ code, name, active });
        created++;
      }
    }

    if (created + updated === 0) {
      return res.status(400).json({
        error: 'No valid teams to import — each row needs a non-empty code (the team name).',
        invalid
      });
    }

    logger.info('Teams imported', { created, updated, invalid: invalid.length, importedBy: req.userId });

    res.status(201).json({ created, updated, invalid });
  } catch (error) {
    next(error);
  }
}

/**
 * List (team, email) roster mappings
 * GET /api/teams/email-mappings?team=XX&email=foo
 */
async function listEmailMappings(req, res, next) {
  try {
    const { page, limit, offset } = parsePagination(req.query);

    const whereClause = {};
    if (req.query.team) {
      whereClause.team = String(req.query.team).trim();
    }
    if (req.query.email) {
      whereClause.email = String(req.query.email).trim().toLowerCase();
    }
    // Free-text search over team name or email (server-side — the roster can
    // exceed the page cap, so a client-side filter would miss rows).
    if (req.query.search && String(req.query.search).trim()) {
      const term = `%${String(req.query.search).trim()}%`;
      whereClause[Op.or] = [
        { team: { [Op.iLike]: term } },
        { email: { [Op.iLike]: term } }
      ];
    }

    const { count, rows } = await TeamEmail.findAndCountAll({
      where: whereClause,
      order: [['team', 'ASC'], ['email', 'ASC']],
      limit,
      offset
    });

    res.json({
      mappings: rows,
      pagination: buildPaginationMeta(count, page, limit)
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Bulk-create (team, email) roster mappings. Every mapping pointing at an
 * already-registered user is applied to their memberships immediately;
 * everyone else picks theirs up on next login.
 * POST /api/teams/email-mappings  { mappings: [{ team, email }] }
 */
async function createEmailMappings(req, res, next) {
  try {
    const { mappings } = req.validatedBody;

    // Reject unknown teams up front so a typo in a pasted roster fails
    // loudly instead of half-importing.
    const validTeams = new Set((await Team.findAll({ attributes: ['code'], raw: true })).map(t => t.code));
    const unknownTeams = [...new Set(mappings.map(m => m.team).filter(team => !validTeams.has(team)))];
    if (unknownTeams.length > 0) {
      throw new ValidationError(`Unknown team(s): ${unknownTeams.join(', ')}. Create the team(s) first.`);
    }

    let created = 0;
    let skipped = 0;
    let applied = 0;

    for (const { team, email } of mappings) {
      const [, wasCreated] = await TeamEmail.findOrCreate({ where: { team, email } });
      if (!wasCreated) {
        skipped++;
        continue;
      }
      created++;
      if (await teamEmailService.applyMappingToExistingUser(team, email)) {
        applied++;
      }
    }

    logger.info('Team email mappings imported', {
      created,
      skipped,
      appliedToExistingUsers: applied,
      createdBy: req.userId
    });

    res.status(201).json({ created, skipped, appliedToExistingUsers: applied });
  } catch (error) {
    next(error);
  }
}

/**
 * Export the full (team, email) roster as CSV. This is the "save" side of the
 * CSV import/export workflow — the downloaded file re-imports cleanly.
 * GET /api/teams/email-mappings/export
 */
async function exportEmailMappings(req, res, next) {
  try {
    const rows = await TeamEmail.findAll({
      order: [['team', 'ASC'], ['email', 'ASC']],
      raw: true
    });

    const escape = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['Team,Email', ...rows.map(r => `${escape(r.team)},${escape(r.email)}`)];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="team-emails.csv"');
    res.send(lines.join('\n'));
  } catch (error) {
    next(error);
  }
}

/**
 * Delete a roster mapping. Memberships already granted from it are removed for
 * existing accounts so the roster stays authoritative.
 * DELETE /api/teams/email-mappings/:id
 */
async function deleteEmailMapping(req, res, next) {
  try {
    const mapping = await TeamEmail.findByPk(req.params.id);
    if (!mapping) {
      throw new NotFoundError('Email mapping');
    }

    const { team, email } = mapping;
    await mapping.destroy();

    // Keep the roster authoritative: drop the membership from the matching
    // account too, if any, so removing a roster entry actually revokes access.
    const user = await User.findOne({ where: { email: email.toLowerCase() }, attributes: ['id'] });
    if (user) {
      await UserTeam.destroy({ where: { userId: user.id, team } });
    }

    logger.info('Team email mapping deleted', { team, email, deletedBy: req.userId });

    res.json({ message: 'Email mapping deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  getCodes,
  getById,
  create,
  update,
  delete: deleteTeam,
  exportCsv,
  importCsv,
  listEmailMappings,
  createEmailMappings,
  exportEmailMappings,
  deleteEmailMapping
};
