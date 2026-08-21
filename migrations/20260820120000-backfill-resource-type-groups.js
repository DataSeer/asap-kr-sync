'use strict';

/**
 * Give the built-in resource types their group.
 *
 * `resource_types.type` decides which detection group a KRT row belongs to, and
 * the column defaults to 'lab_material'. The config seeder never set it, so any
 * database provisioned from `db:seed` classified Dataset, Software/code and
 * Protocol as lab materials.
 *
 * The consequence was not cosmetic. `getResourceTypeGroupOrder()` maps a type
 * NAME to a group number, and each seeded detection strategy loads the author's
 * rows for its own group: datasets asks for 0, software 1, protocols 2,
 * materials 3. With every name mapped to 3, the first three received no author
 * seeds at all while materials received the entire table.
 *
 * Deliberately narrow, so it is safe to run anywhere:
 *   - only the three built-in names are touched;
 *   - only rows still sitting at the default are updated, so a curator who
 *     already corrected them by hand (which is how the working databases were
 *     repaired) is not overwritten;
 *   - re-running changes nothing.
 *
 * The seeder is fixed too — this exists for databases already created by it.
 */

const GROUPS = [
  ['Dataset', 'dataset'],
  ['Software/code', 'software'],
  ['Protocol', 'protocol']
];

module.exports = {
  async up(queryInterface) {
    for (const [name, type] of GROUPS) {
      await queryInterface.sequelize.query(
        `UPDATE "resource_types"
            SET "type" = :type, "updated_at" = NOW()
          WHERE "name" = :name
            AND "type" = 'lab_material'`,
        { replacements: { name, type } }
      );
    }
  },

  async down(queryInterface) {
    // Reversible, but only back to the broken classification — restore the
    // default for exactly the three rows this migration can have set.
    for (const [name, type] of GROUPS) {
      await queryInterface.sequelize.query(
        `UPDATE "resource_types"
            SET "type" = 'lab_material', "updated_at" = NOW()
          WHERE "name" = :name
            AND "type" = :type`,
        { replacements: { name, type } }
      );
    }
  }
};
