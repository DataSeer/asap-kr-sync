/**
 * Seeder: Seed resource types and app config from JSON files
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

// Resource types (singular/canonical form matching validation rules).
// Order here drives sort_order, which is what the KRT Editor uses to sort
// rows within a tab (resource_type sort_order, then resource_name).
const resourceTypes = [
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

// Validation rules from validation-rules.json
const validationRules = {
  'RESOURCE TYPE': {
    required: true,
    type: 'enum',
    values: [
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
    ],
    errorMessage: 'Must be one of the predefined resource types'
  },
  'RESOURCE NAME': {
    required: true,
    type: 'string',
    minLength: 1,
    maxLength: 500,
    errorMessage: 'Resource name is required'
  },
  'SOURCE': {
    required: true,
    type: 'string',
    minLength: 1,
    maxLength: 500,
    errorMessage: 'Source is required'
  },
  'IDENTIFIER': {
    required: true,
    type: 'identifier',
    patterns: {
      doi: '10\\.\\d{4,}/[^\\s]+',
      rrid: 'RRID:[A-Za-z]+_[A-Za-z0-9]+',
      url: 'https?://[^\\s]+',
      catalog: '[A-Za-z0-9\\-#]+'
    },
    errorMessage: 'Must contain a valid identifier (DOI, RRID, URL, or catalog number)'
  },
  'NEW/REUSE': {
    required: true,
    type: 'enum',
    values: ['new', 'reuse'],
    caseInsensitive: true,
    errorMessage: "Must be 'new' or 'reuse'"
  },
  'ADDITIONAL INFORMATION': {
    required: false,
    type: 'string',
    maxLength: 2000,
    errorMessage: 'Additional information must be less than 2000 characters'
  }
};

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // Insert resource types with sort_order
    const resourceTypeRecords = resourceTypes.map((name, index) => ({
      id: uuidv4(),
      name,
      description: null,
      active: true,
      sort_order: index,
      created_at: now,
      updated_at: now
    }));

    await queryInterface.bulkInsert('resource_types', resourceTypeRecords);

    // Insert validation rules config
    await queryInterface.bulkInsert('app_config', [
      {
        id: uuidv4(),
        key: 'validation_rules',
        value: JSON.stringify(validationRules),
        description: 'KRT validation rules for each column',
        category: 'krt',
        created_at: now,
        updated_at: now
      }
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('resource_types', null, {});
    await queryInterface.bulkDelete('app_config', { key: 'validation_rules' }, {});
  }
};
