# Development Guide

This document provides essential information for developers working on this project, including setup instructions, common patterns, and important lessons learned from implementation.

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Development Setup](#development-setup)
3. [Working with NestJS + Fastify](#working-with-nestjs--fastify)
4. [Database Patterns](#database-patterns)
5. [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
6. [Testing Guidelines](#testing-guidelines)
7. [Debugging Tips](#debugging-tips)

---

## Technology Stack

### Backend
- **Framework**: NestJS with **Fastify adapter** (NOT Express)
- **ORM**: Prisma with PostgreSQL
- **Authentication**: Passport.js (Google OAuth)
- **Validation**: Zod schemas with nestjs-zod
- **Documentation**: OpenAPI 3.1, served as a Scalar reference at `/api/docs`

### Key Difference: Fastify vs Express

This application uses **Fastify** as the HTTP adapter, not Express. This has important implications for how you write controllers and work with request/response objects.

**Why Fastify?**
- Faster performance (2-3x faster than Express)
- Better TypeScript support
- Lower overhead
- Built-in schema validation support

---

## Development Setup

### Prerequisites
- Node.js 24+ (see `.nvmrc`; enforced by the `engines` field)
- Docker Desktop
- PostgreSQL (via Docker)
- Google OAuth credentials (from Google Cloud Console)

### Initial Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repository-url>
   cd EnterpriseAppBase
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cd infra/compose
   cp .env.example .env
   # Edit .env with your Google OAuth credentials and other settings
   ```

3. **Start development environment**
   ```bash
   cd infra/compose
   docker compose -f base.compose.yml -f dev.compose.yml up
   ```

4. **IMPORTANT: Run database seeds**

   Before your first login, you MUST seed the database with roles and permissions:

   ```bash
   # In a new terminal, exec into the API container
   docker compose exec api sh

   # Run the seed script
   cd /app/apps/api
   npx prisma db seed

   # Exit the container
   exit
   ```

   **Why this is critical:**
   - Seeds create the RBAC roles (admin, contributor, viewer)
   - Seeds create permissions (users:read, users:write, etc.)
   - Without seeds, user creation will fail with "Default role not found"
   - Seeds are idempotent - safe to run multiple times

5. **Access the application**
   - Frontend: http://localhost:3535
   - API: http://localhost:3535/api
   - API reference: http://localhost:3535/api/docs

### Building images directly

The `docker compose` commands above are unchanged. If you invoke `docker build`
yourself, note that **both images build from the repository root, not from the
app directory**:

```bash
# From the repository root
docker build -f apps/api/Dockerfile .
docker build -f apps/web/Dockerfile .
```

`apps/api` and `apps/web` are npm workspace members with no lockfile of their
own — the only `package-lock.json` is at the repository root. Building from the
root is what makes it reachable, so the images install with `npm ci` and match
what CI tested. Building from inside `apps/api` will fail.

### First Login

The first user to login with the email matching `INITIAL_ADMIN_EMAIL` (from .env) will automatically be granted the **admin** role. All subsequent users get the **viewer** role by default.

---

## Working with NestJS + Fastify

### Critical Differences from Express

#### 1. Response Methods

**❌ WRONG (Express-style):**
```typescript
@Get('example')
example(@Res() res: Response) {
  return res.status(200).json({ data: 'Hello' });
}
```

**✅ CORRECT (Fastify-style):**
```typescript
@Get('example')
example(@Res() res: FastifyReply) {
  return res.code(200).send({ data: 'Hello' });
}
```

**Key Differences:**
- Use `code()` instead of `status()`
- Use `send()` instead of `json()`
- Import types from `fastify` not `express`

**Best Practice:**
Most of the time, avoid using `@Res()` decorator directly. Let NestJS handle responses:

```typescript
@Get('example')
example() {
  // NestJS automatically serializes to JSON
  return { data: 'Hello' };
}
```

#### 2. Request Objects

**Type Imports:**
```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

// NOT from express:
// import { Request, Response } from 'express';
```

**Request Properties:**
```typescript
@Get('example')
example(@Req() req: FastifyRequest) {
  // Fastify uses req.body, req.params, req.query like Express
  // But some properties differ
  const ip = req.ip;           // Client IP
  const protocol = req.protocol; // http/https
  const hostname = req.hostname; // Host header
}
```

### Passport OAuth with Fastify

Passport strategies (like Google OAuth) are designed for Express and expect Express-style request/response objects. To work with Fastify, you need special handling.

#### The Problem

Passport OAuth guards expect to work with Node.js `IncomingMessage` and `ServerResponse` objects, but Fastify wraps these in its own request/response objects.

#### The Solution

Override `getRequest()` and `getResponse()` in your OAuth guard to return the raw Node.js objects:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  getRequest(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Return the raw Node.js IncomingMessage for Passport compatibility
    return request.raw || request;
  }

  getResponse(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse();
    // Return the raw Node.js ServerResponse for Passport compatibility
    return response.raw || response;
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      throw err || new Error('Authentication failed');
    }

    // IMPORTANT: Copy user from raw request to Fastify request
    // so controllers can access req.user normally
    const fastifyRequest = context.switchToHttp().getRequest();
    fastifyRequest.user = user;

    return user;
  }
}
```

**What this does:**
1. `getRequest()` returns `request.raw` - the underlying Node.js request object
2. `getResponse()` returns `response.raw` - the underlying Node.js response object
3. Passport performs OAuth using these raw objects
4. `handleRequest()` copies the authenticated user back to the Fastify request
5. Your controllers can now access `req.user` as normal

**Example in Controller:**
```typescript
@Get('google/callback')
@Public()
@UseGuards(GoogleOAuthGuard)
async googleAuthCallback(
  @Req() req: FastifyRequest & { user?: GoogleProfile },
  @Res() res: FastifyReply,
) {
  // Guard has set req.user for us
  const profile = req.user;

  // Use Fastify methods for response
  return res.redirect(302, redirectUrl.toString());
}
```

### Cookies with Fastify

Fastify uses `@fastify/cookie` plugin for cookie handling.

**Set Cookie:**
```typescript
res.setCookie('name', 'value', {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/api/auth',
  maxAge: 14 * 24 * 60 * 60 * 1000, // milliseconds
});
```

**Read Cookie:**
```typescript
const value = req.cookies['name'];
```

**Clear Cookie:**
```typescript
res.clearCookie('name', { path: '/api/auth' });
```

---

## Database Patterns

### Prisma Transactions

When creating related records (e.g., user with roles), always use transactions to maintain data consistency.

#### Why Transactions Matter

Without transactions, you can encounter foreign key violations:

**❌ WRONG (No Transaction):**
```typescript
// This can fail if user creation succeeds but role assignment fails
const user = await prisma.user.create({
  data: { email, displayName }
});

await prisma.userRole.create({
  data: {
    userId: user.id,
    roleId: defaultRole.id, // FK violation if role doesn't exist
  }
});
```

**✅ CORRECT (With Transaction):**
```typescript
const user = await prisma.$transaction(async (tx) => {
  const newUser = await tx.user.create({
    data: {
      email,
      displayName,
      userRoles: {
        create: {
          roleId: defaultRole.id,
        },
      },
      userSettings: {
        create: {
          value: DEFAULT_USER_SETTINGS,
        },
      },
    },
    include: {
      userRoles: {
        include: { role: true },
      },
    },
  });

  return newUser;
});
```

**Benefits:**
- All-or-nothing: Either all records are created or none
- No orphaned records
- No foreign key violations
- Consistent database state

### Nested Creates

Prisma supports nested creates which are automatically wrapped in transactions:

```typescript
const user = await prisma.user.create({
  data: {
    email: 'user@example.com',
    // Create related records in the same operation
    identities: {
      create: {
        provider: 'google',
        providerSubject: 'google-id-123',
        providerEmail: 'user@example.com',
      },
    },
    userRoles: {
      create: {
        roleId: roleId,
      },
    },
    userSettings: {
      create: {
        value: { theme: 'light' },
      },
    },
  },
  include: {
    identities: true,
    userRoles: { include: { role: true } },
    userSettings: true,
  },
});
```

### Seeding the Database

The seed script (`apps/api/prisma/seed.ts`) is idempotent and safe to run multiple times.

**Running Seeds:**

**In Docker:**
```bash
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
```

**Locally:**
```bash
cd apps/api
npx tsx prisma/seed.ts
```

**What Gets Seeded:**
- RBAC roles (admin, contributor, viewer)
- RBAC permissions (users:read, users:write, system_settings:read, etc.)
- Role-permission assignments
- Default system settings

**When to Run Seeds:**
- Before first login
- After database reset
- After pulling schema changes that add new roles/permissions
- In CI/CD before running tests

---

## Common Pitfalls and Solutions

### 1. "Default role not found" Error

**Symptom:** First OAuth login fails with database error.

**Cause:** Database hasn't been seeded with RBAC roles.

**Solution:**
```bash
docker compose exec api sh
cd /app/apps/api
npx tsx prisma/seed.ts
exit
```

### 2. Passport OAuth Not Working with Fastify

**Symptom:** OAuth redirect fails, or user object is undefined in callback.

**Cause:** Passport expects Express-style request/response objects.

**Solution:** Use the guard pattern shown above with `getRequest()`, `getResponse()`, and `handleRequest()` overrides to return raw Node.js objects and copy user back to Fastify request.

### 3. Response Method Not Working

**Symptom:** `res.status(200).json()` throws an error.

**Cause:** Using Express-style methods with Fastify adapter.

**Solution:** Use Fastify methods: `res.code(200).send()` or let NestJS handle the response.

### 4. Foreign Key Violation on User Creation

**Symptom:** User creation fails with FK constraint error.

**Cause:** Not using transaction when creating user with roles.

**Solution:** Wrap in `prisma.$transaction()` or use nested creates.

### 5. Error Messages in Redirect URLs

**Symptom:** Redirect fails or displays malformed error message.

**Cause:** Error messages contain newlines or special characters not safe for URLs.

**Solution:** Sanitize error messages before adding to URL:
```typescript
const errorMessage = error instanceof Error
  ? encodeURIComponent(error.message.replace(/[\r\n]/g, ' ').substring(0, 100))
  : 'authentication_failed';
return res.redirect(`${appUrl}/auth/callback?error=${errorMessage}`);
```

---

## Testing Guidelines

### Running Tests

**Backend Tests:**
```bash
cd apps/api
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:cov        # With coverage
npm run test:e2e        # E2E tests only
```

**Frontend Tests:**
```bash
cd apps/web
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage
```

### Test Database

Backend tests use a separate test database. Configure in `apps/api/.env.test`:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/app_test"
JWT_SECRET="test-secret-key-min-32-characters"
NODE_ENV="test"
```

**Important:** The test database is truncated between test runs. Never point tests at your development database.

### Mocking OAuth in Tests

OAuth strategies are mocked in tests to avoid external dependencies:

```typescript
import { MockGoogleStrategy } from '../../test/mocks/google-oauth.mock';

// Set custom profile for test
MockGoogleStrategy.setMockProfile({
  email: 'test@example.com',
  displayName: 'Test User',
});

// Perform OAuth test
const response = await request(app.getHttpServer())
  .get('/api/auth/google/callback')
  .expect(302);
```

---

## Debugging Tips

### Debugging OAuth Flow

1. **Check Environment Variables:**
   ```bash
   echo $GOOGLE_CLIENT_ID
   echo $GOOGLE_CLIENT_SECRET
   echo $GOOGLE_CALLBACK_URL
   ```

2. **Verify Callback URL:**
   - Must match exactly in Google Cloud Console
   - Include protocol: `http://` or `https://`
   - Include port if not 80/443: `http://localhost:3535/api/auth/google/callback`

3. **Check Container Logs:**
   ```bash
   docker compose logs api -f
   ```

4. **Test OAuth Provider Endpoint:**
   ```bash
   curl http://localhost:3535/api/auth/providers
   ```

### Debugging Database Issues

1. **Check Prisma Connection:**
   ```bash
   cd apps/api
   npx prisma db push --preview-feature
   ```

2. **Inspect Database:**

   The compose stack does not bundle a `db` service — PostgreSQL runs
   separately and is reached via the `POSTGRES_HOST`/`POSTGRES_PORT` values
   in `.env`. Connect to it directly:
   ```bash
   psql -h $POSTGRES_HOST -p $POSTGRES_PORT -U postgres -d appdb
   \dt              # List tables
   SELECT * FROM roles;
   SELECT * FROM permissions;
   ```

3. **View Prisma Logs:**
   Set `LOG_LEVEL=debug` in `.env` to see SQL queries.

### Common Log Messages

**"Database connected"**
✅ Prisma successfully connected to PostgreSQL

**"User logged out: user@example.com"**
✅ Logout successful

**"Refresh token reuse detected for user: xxx"**
⚠️ Security alert: Possible token theft

**"Default role not found - run database seeds"**
❌ Database not seeded - run `npx tsx prisma/seed.ts`

---

## Development Workflow

### Making Database Changes

1. **Update Prisma Schema:**
   ```bash
   cd apps/api
   # Edit prisma/schema.prisma
   ```

2. **Create Migration:**
   ```bash
   # Using npm script (recommended - handles environment variables)
   npm run prisma:migrate:dev -- --name descriptive_name

   # Or in Docker container
   docker compose exec api npm run prisma:migrate:dev -- --name descriptive_name
   ```

3. **Generate Prisma Client:**
   ```bash
   # Using npm script (recommended)
   npm run prisma:generate

   # Or in Docker container
   docker compose exec api npm run prisma:generate
   ```

4. **Update Seeds (if needed):**
   ```bash
   # Edit prisma/seed.ts
   npx tsx prisma/seed.ts
   ```

**Note:** The project uses individual database environment variables (`POSTGRES_HOST`, `POSTGRES_PORT`, etc.) instead of a single `DATABASE_URL`. The npm scripts (`prisma:*`) automatically construct the connection URL from these variables. See `apps/api/scripts/README.md` for details.

### Adding New API Endpoints

1. Create DTO with Zod schema
2. Add controller method with guards
3. Implement service method with business logic
4. Add OpenAPI decorators for documentation (see [`docs/specs/api-documentation.md`](specs/api-documentation.md))
5. Write tests (unit + integration)
6. Update API.md documentation

### Adding New Guards

1. Create guard in `apps/api/src/auth/guards/`
2. Implement `canActivate()` method
3. Register in module if not global
4. Add tests for guard logic
5. Document usage in SECURITY.md

---

## Performance Considerations

### Fastify Performance Tips

1. **Avoid `@Res()` decorator when possible** - Let NestJS handle serialization
2. **Use schema validation** - Fastify's built-in validation is faster than runtime checks
3. **Enable compression** - Use `@fastify/compress` for large responses
4. **Connection pooling** - Prisma handles this automatically

### Database Query Optimization

1. **Use `select` to limit fields:**
   ```typescript
   const user = await prisma.user.findUnique({
     where: { id },
     select: { id: true, email: true, displayName: true },
   });
   ```

2. **Use `include` judiciously:**
   ```typescript
   // Only include what you need
   include: {
     userRoles: {
       include: { role: true }, // Avoid deep nesting
     },
   }
   ```

3. **Index frequently queried fields** - Already done in schema for email, provider combinations

---

## Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Fastify Documentation](https://www.fastify.io/)
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Passport.js Documentation](http://www.passportjs.org/)
- [Project SECURITY-ARCHITECTURE.md](./SECURITY-ARCHITECTURE.md)
- [Project TESTING.md](./TESTING.md)

---

## Getting Help

If you encounter issues:

1. Check this guide for common pitfalls
2. Review container logs: `docker compose logs api -f`
3. Verify database seeds have run
4. Check environment variables are set correctly
5. Consult the specification docs in `docs/specs/`
6. Ask the team in Slack/Teams

## Summary

Key takeaways for developers:

- ✅ **Use Fastify methods**: `code()` and `send()`, not `status()` and `json()`
- ✅ **Seed before first login**: `npx tsx prisma/seed.ts` in the API container
- ✅ **Use transactions**: Wrap related creates in `prisma.$transaction()`
- ✅ **Return raw objects for OAuth**: Override guard methods for Passport compatibility
- ✅ **Sanitize redirect URLs**: Encode and remove newlines from error messages

Following these patterns will help you avoid the most common issues and maintain consistency with the existing codebase.
