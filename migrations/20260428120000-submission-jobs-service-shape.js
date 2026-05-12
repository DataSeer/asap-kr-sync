'use strict';

/**
 * Translate the legacy submission_jobs.result.service shape into the new
 * { config, outcome } shape so the rewired panel can read every existing row.
 *
 * Legacy shape:
 *   { enabled, hasResponded, demoEnabled, demoFallback }
 *
 * New shape:
 *   {
 *     config:  { state: 'on'|'demo'|'off', enabled: bool, demoEnabled: bool },
 *     outcome: { state: 'done'|'fail', source: 'external'|'demo'|null,
 *                failReason: string|null, externalError: string|null }
 *   }
 *
 * Translation:
 *   config.enabled       <- legacy.enabled
 *   config.demoEnabled   <- legacy.demoEnabled
 *   config.state         <- enabled ? 'on' : (demoEnabled ? 'demo' : 'off')
 *   outcome.source       <- demoFallback ? 'demo' : (hasResponded ? 'external' : null)
 *   outcome.state        <- demoFallback || hasResponded         → 'done'
 *                           !enabled && !demoEnabled (config=Off) → 'done'  (Off resolves to Done)
 *                           else                                  → 'fail'
 *   outcome.failReason   <- null  (we can't reconstruct historical reasons)
 *   outcome.externalError<- null
 *
 * Idempotent: rows whose result.service already has a `config` or `outcome`
 * key are skipped.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE submission_jobs
      SET result = jsonb_set(
        result,
        '{service}',
        jsonb_build_object(
          'config', jsonb_build_object(
            'state',
              CASE
                WHEN COALESCE((result->'service'->>'enabled')::boolean, false) THEN 'on'
                WHEN COALESCE((result->'service'->>'demoEnabled')::boolean, false) THEN 'demo'
                ELSE 'off'
              END,
            'enabled', COALESCE((result->'service'->>'enabled')::boolean, false),
            'demoEnabled', COALESCE((result->'service'->>'demoEnabled')::boolean, false)
          ),
          'outcome', jsonb_build_object(
            'state',
              CASE
                WHEN COALESCE((result->'service'->>'demoFallback')::boolean, false) THEN 'done'
                WHEN COALESCE((result->'service'->>'hasResponded')::boolean, false) THEN 'done'
                -- Off (both flags false) resolves to Done with source=null,
                -- matching the new helper's behaviour.
                WHEN NOT COALESCE((result->'service'->>'enabled')::boolean, false)
                 AND NOT COALESCE((result->'service'->>'demoEnabled')::boolean, false) THEN 'done'
                ELSE 'fail'
              END,
            'source',
              CASE
                WHEN COALESCE((result->'service'->>'demoFallback')::boolean, false) THEN 'demo'
                WHEN COALESCE((result->'service'->>'hasResponded')::boolean, false) THEN 'external'
                ELSE NULL
              END,
            'failReason', NULL,
            'externalError', NULL
          )
        ),
        true
      )
      WHERE result IS NOT NULL
        AND result ? 'service'
        AND NOT (result->'service' ? 'config')
        AND NOT (result->'service' ? 'outcome');
    `);
  },

  /**
   * Reverse: collapse { config, outcome } back to the legacy four flags.
   * Lossy — failReason and externalError are dropped on the way down.
   */
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE submission_jobs
      SET result = jsonb_set(
        result,
        '{service}',
        jsonb_build_object(
          'enabled',      COALESCE((result->'service'->'config'->>'enabled')::boolean, false),
          'demoEnabled',  COALESCE((result->'service'->'config'->>'demoEnabled')::boolean, false),
          'demoFallback', (result->'service'->'outcome'->>'source') = 'demo',
          'hasResponded', (result->'service'->'outcome'->>'source') = 'external'
        ),
        true
      )
      WHERE result IS NOT NULL
        AND result ? 'service'
        AND result->'service' ? 'config'
        AND result->'service' ? 'outcome';
    `);
  }
};
