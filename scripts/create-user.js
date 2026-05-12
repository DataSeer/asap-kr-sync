#!/usr/bin/env node

/**
 * Create User Script
 * Usage: node scripts/create-user.js --email=email@example.com --password=password --name="User Name" --role=admin
 */

require('dotenv').config({ path: '.env' });

const { User, sequelize } = require('../src/backend/models');

async function createUser() {
  const args = process.argv.slice(2);
  const params = {};

  args.forEach(arg => {
    const [key, value] = arg.replace('--', '').split('=');
    params[key] = value;
  });

  const { email, password, name, role = 'author', team } = params;

  if (!email || !password || !name) {
    console.error('Usage: node scripts/create-user.js --email=email@example.com --password=password --name="User Name" [--role=admin] [--team=WH]');
    process.exit(1);
  }

  try {
    await sequelize.authenticate();

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      console.error('Error: User with this email already exists');
      process.exit(1);
    }

    const user = await User.create({
      email,
      passwordHash: password,
      name,
      role,
      team: team || null
    });

    console.log('User created successfully:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Role: ${user.role}`);
    if (user.team) console.log(`  Team: ${user.team}`);

    process.exit(0);
  } catch (error) {
    console.error('Error creating user:', error.message);
    process.exit(1);
  }
}

createUser();
