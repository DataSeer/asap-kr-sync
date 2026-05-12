#!/usr/bin/env node

/**
 * Generate JWT Secret
 * Usage: node scripts/generate-jwt-secret.js
 */

const crypto = require('crypto');

const secret = crypto.randomBytes(64).toString('hex');

console.log('Generated JWT Secret:');
console.log('');
console.log(secret);
console.log('');
console.log('Add this to your .env file:');
console.log(`JWT_SECRET=${secret}`);
