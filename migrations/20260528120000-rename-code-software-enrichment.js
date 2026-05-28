'use strict';

/**
 * Follow-up to 20260522120000-rename-code-software: the previous migration
 * renamed "Code/Software" → "Software/code" in resource_types, krt_data,
 * and the validation_rules entry in app_config, but missed
 * enrichment_list_entries. The identifier scanner reads that table to
 * resolve RRID / DOI / catalog hits and propagates `resource_type`
 * verbatim onto the Generated KRT, so every identifier match was still
 * emitting the historic "Code/Software" label — which the KRT validator
 * then rejected as "Invalid resource type: 'Code/Software'".
 *
 * The backend now also normalises at the emission boundary
 * (identifier-detection.service.js calls canonicalResourceType), so this
 * migration is "defence at the source": the data on disk matches what
 * every consumer expects, and any code path that bypasses the scanner
 * still sees the canonical label.
 */
module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query(
      `UPDATE enrichment_list_entries
          SET resource_type = 'Software/code', updated_at = NOW()
        WHERE resource_type = 'Code/Software'`
    );
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    await sql.query(
      `UPDATE enrichment_list_entries
          SET resource_type = 'Code/Software', updated_at = NOW()
        WHERE resource_type = 'Software/code'`
    );
  }
};
