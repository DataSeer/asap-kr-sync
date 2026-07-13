#!/usr/bin/env node

/**
 * Import the ASAP roster (team, email) from a CSV into the team model.
 *
 * For each (team, email) row it:
 *   1. upserts the team (teams.code = team name),
 *   2. upserts the email→team roster entry (team_emails),
 *   3. if a user account already exists for that email, ensures the
 *      corresponding user_teams membership (so visibility applies immediately).
 *
 * Emails without an account are still recorded in team_emails and applied when
 * that person registers or next signs in (see team-email.service).
 *
 * The CSV must have a header with a "Team" column and an "Email" column (any
 * other columns are ignored). This matches the exported roster shape.
 *
 * Usage:
 *   node scripts/import-user-teams.js --file="tmp/user-team.csv" [--dry-run]
 */

require('dotenv').config({ path: '.env' });

const fs = require('fs');
const Papa = require('papaparse');
const validator = require('validator');
const { sequelize, Team, TeamEmail, UserTeam, User } = require('../src/backend/models');

function parseArgs() {
  const params = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    params[key] = value === undefined ? true : value;
  }
  return params;
}

/** Find a column index by case-insensitive header match. */
function columnIndex(header, ...names) {
  const lower = header.map(h => String(h).trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

async function main() {
  const { file, 'dry-run': dryRun } = parseArgs();
  if (!file) {
    console.error('Usage: node scripts/import-user-teams.js --file=path/to/roster.csv [--dry-run]');
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');
  // header:false → array-of-arrays; the roster's header spans multiple lines,
  // so we locate columns from the first row ourselves. Papa handles quoted
  // fields (commas/newlines inside quotes) correctly.
  const { data: records } = Papa.parse(raw.trim(), { header: false, skipEmptyLines: true });
  if (records.length < 2) {
    console.error('CSV has no data rows');
    process.exit(1);
  }

  const header = records[0];
  const teamIdx = columnIndex(header, 'team');
  const emailIdx = columnIndex(header, 'email', 'e-mail');
  if (teamIdx === -1 || emailIdx === -1) {
    console.error(`CSV must have Team and Email columns. Got header: ${header.join(', ')}`);
    process.exit(1);
  }

  // Collect valid (team, email) pairs, deduped. Use the same isEmail check the
  // TeamEmail model enforces, so nothing fails validation mid-transaction.
  const pairs = new Map(); // key `${team}|${email}` -> { team, email }
  const teams = new Set();
  let skipped = 0;
  for (const row of records.slice(1)) {
    const team = String(row[teamIdx] || '').trim();
    const email = String(row[emailIdx] || '').trim().toLowerCase();
    // Skip blanks, malformed emails, and non-team artifacts (leaked header
    // fragments etc.).
    if (!team || !validator.isEmail(email) || team.includes('(') || team.length > 100) {
      if (team || email) skipped++;
      continue;
    }
    teams.add(team);
    pairs.set(`${team}|${email}`, { team, email });
  }

  console.log(`Parsed ${pairs.size} unique (team, email) pairs across ${teams.size} teams (${skipped} rows skipped).`);
  if (dryRun) {
    console.log('Teams:', [...teams].sort().join(', '));
    console.log('(dry run — no writes)');
    await sequelize.close();
    return;
  }

  await sequelize.authenticate();
  const stats = { teams: 0, mappings: 0, memberships: 0 };

  await sequelize.transaction(async (t) => {
    // 1. teams
    for (const name of teams) {
      const [, created] = await Team.findOrCreate({
        where: { code: name },
        defaults: { code: name, name, active: true },
        transaction: t
      });
      if (created) stats.teams++;
    }

    // 2. team_emails roster
    for (const { team, email } of pairs.values()) {
      const [, created] = await TeamEmail.findOrCreate({
        where: { team, email },
        defaults: { team, email },
        transaction: t
      });
      if (created) stats.mappings++;
    }

    // 3. apply to existing accounts
    const emails = [...new Set([...pairs.values()].map(p => p.email))];
    const users = await User.findAll({
      where: { email: emails },
      attributes: ['id', 'email'],
      transaction: t
    });
    const userByEmail = new Map(users.map(u => [u.email.toLowerCase(), u.id]));
    for (const { team, email } of pairs.values()) {
      const userId = userByEmail.get(email);
      if (!userId) continue;
      const [, created] = await UserTeam.findOrCreate({
        where: { userId, team },
        defaults: { userId, team },
        transaction: t
      });
      if (created) stats.memberships++;
    }
  });

  console.log(`Done. Created ${stats.teams} teams, ${stats.mappings} roster entries, ${stats.memberships} memberships for existing users.`);
  await sequelize.close();
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
