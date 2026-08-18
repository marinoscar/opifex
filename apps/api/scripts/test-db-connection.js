#!/usr/bin/env node
/**
 * Test Database Connection
 *
 * Verifies that DATABASE_URL can be constructed from individual
 * PostgreSQL environment variables and that the database is accessible.
 *
 * Usage:
 *   node scripts/test-db-connection.js
 */

const { Client } = require('pg');

// Load .env files - try multiple locations
if (process.env.NODE_ENV !== 'production') {
  try {
    const path = require('path');
    const dotenv = require('dotenv');

    // Try local .env first (apps/api/.env)
    dotenv.config();

    // Also load from infra/compose/.env (canonical env location)
    const composeEnv = path.resolve(__dirname, '..', '..', '..', 'infra', 'compose', '.env');
    dotenv.config({ path: composeEnv });
  } catch (err) {
    // dotenv might not be available, that's OK
  }
}

/**
 * Constructs PostgreSQL connection URL from individual environment variables
 */
function constructDatabaseUrl() {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const dbName = process.env.POSTGRES_DB || 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';

  // Construct URL-safe password
  const encodedPassword = encodeURIComponent(password);

  // Build SSL parameter
  const sslParam = ssl ? '?sslmode=require' : '';

  return `postgresql://${user}:${encodedPassword}@${host}:${port}/${dbName}${sslParam}`;
}

/**
 * Test database connection
 */
async function testConnection() {
  console.log('Testing Database Connection');
  console.log('===========================\n');

  // Show configuration
  console.log('Environment Variables:');
  console.log(`  POSTGRES_HOST: ${process.env.POSTGRES_HOST || 'localhost (default)'}`);
  console.log(`  POSTGRES_PORT: ${process.env.POSTGRES_PORT || '5432 (default)'}`);
  console.log(`  POSTGRES_USER: ${process.env.POSTGRES_USER || 'postgres (default)'}`);
  console.log(`  POSTGRES_DB: ${process.env.POSTGRES_DB || 'appdb (default)'}`);
  console.log(`  POSTGRES_SSL: ${process.env.POSTGRES_SSL || 'false (default)'}`);
  console.log('');

  // Construct connection URL
  const databaseUrl = constructDatabaseUrl();

  // Show constructed URL (hide password)
  const maskedUrl = databaseUrl.replace(/:([^@]+)@/, ':****@');
  console.log('Constructed DATABASE_URL:');
  console.log(`  ${maskedUrl}`);
  console.log('');

  // Test connection
  const client = new Client({ connectionString: databaseUrl });

  try {
    console.log('Attempting connection...');
    await client.connect();
    console.log('✓ Connected successfully!\n');

    // Run a simple query
    const result = await client.query('SELECT version()');
    console.log('PostgreSQL Version:');
    console.log(`  ${result.rows[0].version}\n`);

    // Show current database
    const dbResult = await client.query('SELECT current_database()');
    console.log('Current Database:');
    console.log(`  ${dbResult.rows[0].current_database}\n`);

    console.log('✓ Database connection test PASSED');
    process.exit(0);
  } catch (err) {
    console.error('✗ Connection failed!');
    console.error('');
    console.error('Error details:');
    console.error(`  ${err.message}`);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  1. Verify database is running and accessible');
    console.error('  2. Check environment variables are set correctly');
    console.error('  3. Verify network connectivity to database');
    console.error('  4. Check database credentials are correct');
    console.error('');
    process.exit(1);
  } finally {
    await client.end();
  }
}

testConnection().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
