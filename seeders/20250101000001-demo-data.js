'use strict';

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Production safety gate: never seed demo users with the well-known
    // password ("password123") into a production database. Operators who
    // genuinely need the demo data on a non-prod-but-NODE_ENV=production host
    // (e.g. a pre-staging box) can opt in with ALLOW_DEMO_SEED=true.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
      console.log('Demo seeder skipped: NODE_ENV=production and ALLOW_DEMO_SEED is not "true".');
      console.log('Use the create-user script to provision admins on production.');
      return;
    }

    // Check if any users already exist (e.g., preserved users from --preserve-users)
    const [allUsers] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) as count FROM users`
    );

    if (allUsers[0].count > 0) {
      console.log(`Found ${allUsers[0].count} existing user(s), skipping demo user seeding...`);
      console.log('(Use the create-user script to add new users if needed)');
      return;
    }

    // Create demo users
    const adminId = uuidv4();
    const authorId = uuidv4();
    const pmId = uuidv4();
    const annotatorId = uuidv4();

    const passwordHash = await bcrypt.hash('password123', 12);

    await queryInterface.bulkInsert('users', [
      {
        id: adminId,
        email: 'admin@example.com',
        password_hash: passwordHash,
        name: 'Admin User',
        role: 'admin',
        team: null,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: authorId,
        email: 'author@example.com',
        password_hash: passwordHash,
        name: 'John Author',
        role: 'author',
        team: null,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: pmId,
        email: 'pm@example.com',
        password_hash: passwordHash,
        name: 'Jane PM',
        role: 'asap_pm',
        team: 'WH',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        id: annotatorId,
        email: 'annotator@example.com',
        password_hash: passwordHash,
        name: 'Sam Annotator',
        role: 'ds_annotator',
        team: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    console.log('Demo users seeded successfully');
    console.log('');
    console.log('Demo accounts:');
    console.log('  Admin: admin@example.com / password123');
    console.log('  Author: author@example.com / password123');
    console.log('  ASAP PM (Team WH): pm@example.com / password123');
    console.log('  DS Annotator: annotator@example.com / password123');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('users', {
      email: ['admin@example.com', 'author@example.com', 'pm@example.com', 'annotator@example.com']
    });
  }
};
