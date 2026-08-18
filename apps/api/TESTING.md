# Testing Guide

This document describes the testing approach and commands for the API.

## Test Types

### Unit Tests
- Located in `src/**/*.spec.ts` (colocated with source files)
- Mock all external dependencies (database, external services)
- Fast execution, no external dependencies required
- **Default for `npm test`**

### E2E Tests (Integration Tests)
- Located in `test/**/*.e2e.spec.ts`
- Test full application with real database
- Require PostgreSQL database to be running
- Run separately with `npm run test:e2e`

## Test Commands

### Run Unit Tests Only (Default)
```bash
npm test
```
This is the default command and runs only unit tests. **No database required.**

### Run E2E Tests
```bash
npm run test:e2e
```
**Requires a PostgreSQL database to be running.** See "Running E2E Tests" section below.

### Run All Tests (Unit + E2E)
```bash
npm run test:all
```
**Requires a PostgreSQL database to be running.**

### Watch Mode (Unit Tests)
```bash
npm run test:watch
```

### Coverage (Unit Tests)
```bash
npm run test:cov
```

### Debug Mode
```bash
npm run test:debug
```

## Running E2E Tests

E2E tests require a PostgreSQL database. You have several options:

### Option 1: Use Docker Compose (Recommended)
```bash
# Start test database
cd ../../infra/compose
docker compose -f base.compose.yml up db -d

# Run E2E tests
cd ../../apps/api
npm run test:e2e

# Stop database when done
cd ../../infra/compose
docker compose -f base.compose.yml down
```

### Option 2: Use Local PostgreSQL
Ensure you have a test database configured and set the `DATABASE_URL` environment variable:

```bash
# Create .env.test file
DATABASE_URL="postgresql://user:password@localhost:5432/testdb"

# Run migrations
npx prisma migrate deploy

# Run E2E tests
npm run test:e2e
```

### Option 3: CI/CD Pipeline
In CI environments, E2E tests should be run with a dedicated test database service.

## Test Structure

### Unit Test Example
```typescript
// src/auth/auth.service.spec.ts
import { Test } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { createMockPrismaService } from '../test/mocks/prisma.mock';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: createMockPrismaService() },
      ],
    }).compile();

    service = module.get(AuthService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

### E2E Test Example
```typescript
// test/auth/auth.e2e.spec.ts
import request from 'supertest';
import { createTestApp, closeTestApp } from '../helpers/test-app.helper';

describe('Auth (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.prisma);
  });

  it('/api/auth/me (GET)', async () => {
    const user = await createTestUser(context);

    return request(context.app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
  });
});
```

## Test Helpers

### Database Helpers
- `test/helpers/database.helper.ts` - Database cleanup and seeding utilities
- `resetDatabase(prisma)` - Cleans and re-seeds the database
- `cleanDatabase(prisma)` - Removes all data from the database
- `seedBaseData(prisma)` - Seeds roles, permissions, and default settings

### Auth Helpers
- `test/helpers/auth.helper.ts` - User creation and authentication utilities
- `createTestUser(context, options)` - Creates a user with JWT token
- `createAdminUser(context)` - Creates an admin user
- `createContributorUser(context)` - Creates a contributor user
- `createViewerUser(context)` - Creates a viewer user
- `authHeader(token)` - Returns Authorization header object

### App Helpers
- `test/helpers/test-app.helper.ts` - Application setup utilities
- `createTestApp()` - Creates a full NestJS application instance
- `closeTestApp(context)` - Closes the application and disconnects from database

### Mocks
- `test/mocks/prisma.mock.ts` - Mock PrismaService for unit tests
- `test/mocks/google-oauth.mock.ts` - Mock Google OAuth profiles

## Best Practices

1. **Unit tests should never connect to a real database** - Always use mocked PrismaService
2. **E2E tests should use a dedicated test database** - Never use development or production databases
3. **Clean database between E2E tests** - Use `resetDatabase()` in `beforeEach()`
4. **Use test helpers** - Don't duplicate user creation or authentication logic
5. **Fast feedback loop** - Run `npm test` (unit tests only) during development
6. **Pre-commit validation** - Ensure unit tests pass before committing
7. **CI pipeline** - Run both unit and E2E tests in CI with a test database

## Troubleshooting

### "Can't reach database server" Error
This means you're trying to run E2E tests without a database. Either:
- Run unit tests only: `npm test`
- Start a database and then run: `npm run test:e2e`

### Tests Timing Out
- Increase timeout in `test/jest.config.js` (currently 30 seconds)
- Check if database is slow or unresponsive
- Consider running tests in parallel: `jest --maxWorkers=4`

### Mock Not Returning Expected Data
- Check that you're using `mockPrisma.method.mockResolvedValue(data)` in your test
- Ensure the mock is reset between tests with `beforeEach()`
- Verify the mock type matches the real Prisma client

## Coverage Goals

- **Unit tests**: 80%+ coverage for business logic (services, guards, validators)
- **E2E tests**: Critical user journeys (auth flow, RBAC, settings CRUD)
- Exclude from coverage: DTOs, modules, main.ts, type definitions
