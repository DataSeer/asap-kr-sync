'use strict';

/**
 * Rename the canonical resource type "Code/Software" to "Software/code" per
 * ASAP team request — they use "Software/code" in their guidance and want it
 * to match throughout the app and in exports.
 *
 * Touches:
 *   1. resource_types.name (the canonical resource type list)
 *   2. krt_data.resource_type (existing user KRT rows)
 *   3. app_config.value where key='validation_rules' (the enum list used by
 *      the KRT validator)
 *
 * SubmissionJob.result snapshots are intentionally left alone — they're a
 * historical record of what each job produced. The validator alias map in
 * validator.service.js still accepts the lowercased forms ('code', 'software',
 * 'code/software'), so any user input that still uses the old spelling is
 * auto-normalised on the next validation.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(
      `UPDATE resource_types SET name = 'Software/code', updated_at = NOW()
       WHERE name = 'Code/Software'`
    );

    await sql.query(
      `UPDATE krt_data SET resource_type = 'Software/code', updated_at = NOW()
       WHERE resource_type = 'Code/Software'`
    );

    // app_config.value is stored as TEXT (JSON string); cast to jsonb to
    // patch the enum array in the validation_rules entry, then cast back to
    // text on assignment. The inner subquery rebuilds the values array with
    // 'Code/Software' replaced by 'Software/code'.
    await sql.query(`
      UPDATE app_config
      SET value = jsonb_set(
            value,
            '{RESOURCE TYPE,values}',
            to_jsonb(array_replace(
              (SELECT array_agg(x) FROM jsonb_array_elements_text(value->'RESOURCE TYPE'->'values') x),
              'Code/Software',
              'Software/code'
            ))
          ),
          updated_at = NOW()
      WHERE key = 'validation_rules'
        AND value::jsonb -> 'RESOURCE TYPE' -> 'values' ? 'Code/Software'
    `);
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;

    await sql.query(
      `UPDATE resource_types SET name = 'Code/Software', updated_at = NOW()
       WHERE name = 'Software/code'`
    );

    await sql.query(
      `UPDATE krt_data SET resource_type = 'Code/Software', updated_at = NOW()
       WHERE resource_type = 'Software/code'`
    );

    await sql.query(`
      UPDATE app_config
      SET value = jsonb_set(
            value,
            '{RESOURCE TYPE,values}',
            to_jsonb(array_replace(
              (SELECT array_agg(x) FROM jsonb_array_elements_text(value->'RESOURCE TYPE'->'values') x),
              'Software/code',
              'Code/Software'
            ))
          ),
          updated_at = NOW()
      WHERE key = 'validation_rules'
        AND value -> 'RESOURCE TYPE' -> 'values' ? 'Software/code'
    `);
  }
};
