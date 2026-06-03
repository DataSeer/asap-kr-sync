'use strict';

/**
 * Reorder resource_types so the KRT Editor's "Key Lab Materials" tab lists
 * subtypes in the user-facing order requested by the team:
 *
 *   Datasets, Software/code, Protocols,
 *   Antibody, Bacterial strain, Viral vector, Biological sample,
 *   Chemical/peptide/recombinant protein, Critical commercial assay,
 *   Experimental model: Cell line, Experimental model: Organism/strain,
 *   Oligonucleotide, Recombinant DNA, Other
 *
 * Names stay in their DB form (singular) — only sort_order moves.
 */
const NEW_ORDER = [
  'Dataset',
  'Software/code',
  'Protocol',
  'Antibody',
  'Bacterial strain',
  'Viral vector',
  'Biological sample',
  'Chemical, peptide, or recombinant protein',
  'Critical commercial assay',
  'Experimental model: Cell line',
  'Experimental model: Organism/strain',
  'Oligonucleotide',
  'Recombinant DNA',
  'Other'
];

// Restore the original seeder order (matches seeders/20250101000002-seed-config.js)
const ORIGINAL_ORDER = [
  'Dataset',
  'Software/code',
  'Protocol',
  'Antibody',
  'Bacterial strain',
  'Biological sample',
  'Chemical, peptide, or recombinant protein',
  'Critical commercial assay',
  'Experimental model: Cell line',
  'Experimental model: Organism/strain',
  'Oligonucleotide',
  'Recombinant DNA',
  'Viral vector',
  'Other'
];

module.exports = {
  async up(queryInterface) {
    const sql = queryInterface.sequelize;
    for (let i = 0; i < NEW_ORDER.length; i++) {
      await sql.query(
        'UPDATE resource_types SET sort_order = :order, updated_at = NOW() WHERE name = :name',
        { replacements: { order: i, name: NEW_ORDER[i] } }
      );
    }
  },

  async down(queryInterface) {
    const sql = queryInterface.sequelize;
    for (let i = 0; i < ORIGINAL_ORDER.length; i++) {
      await sql.query(
        'UPDATE resource_types SET sort_order = :order, updated_at = NOW() WHERE name = :name',
        { replacements: { order: i, name: ORIGINAL_ORDER[i] } }
      );
    }
  }
};
