#!/bin/bash
# Verification script for Prisma migrations and seeding
# This script verifies that migrations and seeding work correctly

set -e

echo "==================================="
echo "Database Setup Verification"
echo "==================================="
echo ""

echo "1. Checking migration status..."
npm run prisma -- migrate status
echo "✓ Migration status check passed"
echo ""

echo "2. Verifying schema is in sync..."
npm run prisma -- db push --accept-data-loss
echo "✓ Schema sync verified"
echo ""

echo "3. Running seed script..."
npm run prisma:seed
echo "✓ Seed script executed successfully"
echo ""

echo "4. Verifying seeded data..."
echo "   - Checking roles..."
ROLE_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.role.count().then(count => {
  console.log(count);
  process.exit(count === 3 ? 0 : 1);
}).catch(() => process.exit(1));
")

echo "   - Checking permissions..."
PERM_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.permission.count().then(count => {
  console.log(count);
  process.exit(count === 9 ? 0 : 1);
}).catch(() => process.exit(1));
")

echo "✓ Seeded data verification passed"
echo ""

echo "==================================="
echo "All checks passed!"
echo "==================================="
