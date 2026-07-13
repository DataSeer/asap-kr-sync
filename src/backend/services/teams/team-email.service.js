/**
 * Team-Email Roster Service
 *
 * Applies the admin-managed (team, email) mapping list (team_emails) to
 * user_teams memberships. This is how ASAP PMs get their teams without
 * uploading anything or waiting for a manual admin assignment: the roster
 * is consulted on every login, on registration, and on admin user creation,
 * and mappings are also pushed to already-registered users the moment an
 * admin adds them.
 *
 * All functions are best-effort where they run inside auth flows — a roster
 * problem must never block a login.
 */

const { Op } = require('sequelize');
const { TeamEmail, UserTeam, User } = require('../../models');
const logger = require('../../utils/logger');

/**
 * Apply every roster mapping matching the user's email as a team membership.
 * Never throws — auth flows call this inline.
 * @param {string} userId - User UUID
 * @param {string} email - The user's email
 * @returns {Promise<string[]>} team codes the user is mapped to (existing and
 *   newly created alike) — callers can merge these into an already-loaded
 *   team list without re-querying
 */
async function applyMappingsForUser(userId, email) {
  if (!userId || !email) return [];

  try {
    const mappings = await TeamEmail.findAll({
      where: { email: email.toLowerCase() },
      attributes: ['team'],
      raw: true
    });
    if (mappings.length === 0) return [];

    const mappedTeams = [...new Set(mappings.map(m => m.team))];
    const existing = await UserTeam.findAll({
      where: { userId, team: { [Op.in]: mappedTeams } },
      attributes: ['team'],
      raw: true
    });
    const existingTeams = new Set(existing.map(ut => ut.team));
    const missing = mappedTeams.filter(team => !existingTeams.has(team));

    if (missing.length > 0) {
      // ignoreDuplicates guards the race of two concurrent logins applying
      // the same mapping (unique index on user_id+team).
      await UserTeam.bulkCreate(
        missing.map(team => ({ userId, team })),
        { ignoreDuplicates: true }
      );
      logger.info('Teams auto-assigned from email roster', { userId, teams: missing });
    }

    return mappedTeams;
  } catch (error) {
    logger.warn('Failed to apply team-email mappings', { userId, error: error.message });
    return [];
  }
}

/**
 * Push a single roster mapping to an already-registered user, if any.
 * Used when an admin adds mappings so existing users don't have to wait for
 * their next login.
 * @param {string} team - Team code
 * @param {string} email - Mapped email
 * @returns {Promise<boolean>} true if an existing user received the membership
 */
async function applyMappingToExistingUser(team, email) {
  const user = await User.findOne({ where: { email: email.toLowerCase() } });
  if (!user) return false;

  const [, created] = await UserTeam.findOrCreate({ where: { userId: user.id, team } });
  if (created) {
    logger.info('Team assigned to existing user from new roster entry', { userId: user.id, team });
  }
  return created;
}

module.exports = {
  applyMappingsForUser,
  applyMappingToExistingUser
};
