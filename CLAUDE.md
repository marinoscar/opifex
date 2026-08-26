# CLAUDE.md

This file provides guidance for AI assistants working on this codebase.

## Project Overview

Web Application Foundation with React UI + Node API + PostgreSQL. Production-grade foundation with OAuth authentication, RBAC authorization, and flexible settings framework.

## Technology Stack

- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth required)
- **Testing**: Jest + Supertest (backend), Vitest + React Testing Library + MSW (frontend, 70% coverage thresholds)
- **Observability**: OpenTelemetry, Uptrace, Pino structured logging
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Nginx (same-origin routing)

## Repository Structure

```
/
  apps/
    api/                    # Backend API
      src/
      test/
      prisma/
        schema.prisma
        migrations/
      Dockerfile            # API container (near its code)
    web/                    # Frontend React app
      src/
      src/__tests__/
      Dockerfile            # Web container (near its code)
  docs/                     # Documentation
  infra/                    # Infrastructure configuration
    compose/
      base.compose.yml       # Core services: api, web, nginx
      dev.compose.yml        # Development overrides (hot reload, volumes)
      prod.compose.yml       # Production overrides (resource limits)
      otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
      .env.example           # Environment variables template
    nginx/
      nginx.conf             # Nginx routing configuration
    otel/
      otel-collector-config.yaml   # OTEL Collector config
      uptrace.yml            # Uptrace configuration
  tests/e2e/                # Optional E2E tests
```

## MANDATORY: Issue-Driven Development (Traceability)

Every feature and bug fix MUST be tracked by a GitHub issue, filed **before** implementation planning is finalized (for features) or the fix starts (for bugs). This applies before any worktree or branch is created — traceability starts at the issue, not the code. Running `gh issue create` from inside the repo infers the target repository from the git remote automatically, so no repo owner/URL needs to be specified.

- **New feature**: Before finalizing an implementation plan, create (or confirm an existing) issue with `gh issue create --template feature_request.yml`. Fill in the real problem statement, proposed solution, affected component, and priority — not placeholder text.
- **Larger initiative**: If the work will span multiple features or sessions, file an Epic instead with `gh issue create --template epic.yml`. Child feature issues must reference the epic number in their body or task list.
- **Architecture decision**: If the work turns on a choice with real tension — two options that cannot both be true, with a cost either way — file the decision first with `gh issue create --template decision_proposal.yml`. The issue is the discussion; the outcome is an ADR under `docs/adr/`, and that ADR's pull request closes the issue. See [`docs/adr/README.md`](docs/adr/README.md). A choice with an obvious answer belongs in a commit message, not an ADR.
- **Bug fix**: Before starting the fix, create (or confirm an existing) issue with `gh issue create --template bug_report.yml`. Fill in the description, reproduction steps, expected vs. actual behavior, component, and environment/logs if known. Do not file a duplicate if one already exists for the same bug — reuse it.
- **Link the work**: Reference the issue number in commit messages and/or the PR description (`Fixes #123` / `Relates to #123`), per the `.github/pull_request_template.md` convention.
- **Always open a PR**: Work on an issue is not finished until a pull request is open for it. See [MANDATORY: Always Open a Pull Request](#mandatory-always-open-a-pull-request) below. A branch pushed without a PR is invisible — it closes no issue, triggers no review, and puts exactly the hole in the provenance chain that VISION.MD §5 says is undetectable after the fact.
- **Keep it current**: Update or close the issue as the corresponding PR resolves it, so issue state reflects real progress.
- **Scope**: This applies to feature and bug work specifically. Routine `chore`/`docs`/`refactor` commits don't each need their own tracking issue.

## MANDATORY: Worktree-Based Feature Development

Every feature or fix MUST be developed in a Git worktree. The main checkout stays on `main` at all times.

### Worktree Location & Naming

- All worktrees live under `worktrees/` in the repo root (git-ignored, never committed)
- Use **flat short names**: `worktrees/<short-name>` (e.g., `worktrees/add-export`, `worktrees/fix-auth-bug`)
- The branch name follows conventional format: `feat/<short-name>`, `fix/<short-name>`, etc.

### Workflow (Claude MUST follow)

**Starting feature work:**

0. Ensure a tracking issue exists, per [MANDATORY: Issue-Driven Development (Traceability)](#mandatory-issue-driven-development-traceability) above.
1. From the main checkout, create the worktree:
   ```bash
   git worktree add worktrees/<short-name> -b <type>/<short-name>
   ```
   Example: `git worktree add worktrees/add-export -b feat/add-export`
2. All development happens inside `worktrees/<short-name>/`
3. Commits follow all existing commit rules (see below)

**Finishing feature work:**

1. Ensure all changes are committed inside the worktree
2. Push the branch and **open the pull request** — see
   [MANDATORY: Always Open a Pull Request](#mandatory-always-open-a-pull-request).
   Do this before removing the worktree, so a failing check can still be
   reproduced and fixed in the tree it was built in.
3. Remove the worktree:
   ```bash
   git worktree remove worktrees/<short-name>
   ```
4. The branch remains, now with an open PR against it

### Rules

- NEVER checkout feature branches in the main working directory
- NEVER work on features directly in the main checkout
- One worktree per feature branch (Git enforces this)
- If the worktree already exists for the requested feature, work inside it (don't recreate)

## MANDATORY: Always Open a Pull Request

**Every piece of issue-tracked work ends in an open pull request.** Committing and
pushing is not finishing. A branch with no PR closes no issue, requests no review, runs
no required checks, and leaves the `Issue → PR → Commit` edge of the provenance graph
missing — which VISION.MD §5 is explicit is not detectable after the fact.

### When to open it

- **As soon as the work is reviewable.** Don't sit on a finished branch waiting to be
  asked. Opening the PR _is_ the last step of the task, not a separate errand.
- **Open it early as a draft** if the work is real but incomplete, or if you want CI to
  run against it while you keep going. A draft PR is always better than an invisible
  branch.
- **One PR per issue**, or one per coherent slice of an epic. Do not bundle unrelated
  issues into a single PR — the closing keywords would then all resolve together and the
  review would have no natural scope.

### What it must contain

- **Fill in `.github/pull_request_template.md`.** Treat its headings as a layout to
  populate, not as suggestions to skim.
- **A closing keyword is required**: `Fixes #123` / `Closes #123` / `Resolves #123`, so
  the issue closes on merge. VISION.MD §5: _"No PR without one — a single orphan puts a
  hole in the graph."_
- **Say what you could not verify.** A PR that claims more than was actually run is worse
  than one that admits a gap, because the gap is then invisible to the reviewer too.

### After it is open

- **Drive it to green.** A red or conflicted PR is work now, not "waiting on review".
  Diagnose the failure, fix it, and push — do not report the failure and stop.
- **Never reuse a merged PR** for follow-up work. A merged PR is finished; restart the
  branch from the latest `main` and open a new one.

### The one exception

If the human explicitly says not to open a PR yet, don't. Their instruction wins over
this rule — but push the branch anyway and tell them the PR is waiting on their word, so
the work is at least recoverable.

---

## MANDATORY: Claude Commit Rules

Claude: these rules are **MANDATORY**. Follow them exactly.  
Your job is to create clean, frequent commits while implementing the requested work, and
then to open the pull request that carries them (see the section above).  
Assume the branch already exists and is checked out unless the worktree workflow above
says otherwise. Do **not** create branches outside that workflow.

---

### Core Commit Rules (MANDATORY)

1. **Commit early, commit often.** Do not leave large uncommitted change sets.
2. Each commit must be **small, coherent, and reviewable**.
3. **One intent per commit** (no “misc fixes” bundles).
4. **Do not include unrelated refactors** unless explicitly requested.
5. If you change behavior, you must add/adjust tests in the same commit or the next immediate commit.

---

### Commit Message Standard (MANDATORY: Conventional Commits)

Use this format:

`<type>(<scope>): <short imperative summary>`

Allowed types:

- `feat:` new functionality
- `fix:` bug fix
- `refactor:` internal change, no behavior change
- `test:` add/adjust tests only
- `docs:` documentation only
- `chore:` tooling, deps, formatting, build, CI

Scopes (pick one relevant area):

- `api`, `web`, `db`, `infra`, `auth`, `chat`, `ui`, `core`, `jobs`, `docs`, `tests`

Examples:

- `feat(chat): add permit search prompt builder`
- `fix(api): handle missing location gracefully`
- `test(api): cover permit filter edge cases`
- `chore(web): run formatter`

---

### Commit Cadence (MANDATORY)

Make commits at these checkpoints:

1. **Scaffold / wiring**

- New files, routes, handlers, basic plumbing (even if incomplete).
- Example: `feat(api): scaffold permit lookup endpoint`

2. **Core functionality**

- Implement the smallest working slice end-to-end.
- Example: `feat(core): implement permit filtering by location radius`

3. **Edge cases + validation**

- Input validation, error handling, fallback behavior.
- Example: `fix(api): validate lat/lng inputs and return 400`

4. **Tests**

- Unit/integration tests for the new behavior and critical edge cases.
- Example: `test(api): add coverage for location filter and empty results`

5. **Cleanup**

- Remove dead code, rename for clarity, small refactors strictly related to the change.
- Example: `refactor(core): extract permit query builder`

6. **Docs (if needed)**

- Only if the task requires it.
- Example: `docs(api): document permit endpoint parameters`

---

### What to Include / Exclude (MANDATORY)

#### Include

- Code + tests for the same feature area
- Minimal config changes needed to run/build/test
- Small, related refactors that reduce complexity for the feature

#### Exclude

- Repo-wide formatting changes unless required
- Dependency upgrades unless required
- Unrelated cleanup in neighboring modules

---

### Commit Command Sequence (MANDATORY)

Before committing:

1. `git status`
2. `git diff`
3. Stage intentionally:
   - `git add -p` (preferred) or `git add <files>`

Commit:

- `git commit -m "<type>(<scope>): <summary>"`

After commit:

- `git status`

Repeat until the next checkpoint is complete, then commit again.

---

### Handling Mixed Changes (MANDATORY)

If you accidentally made unrelated edits:

- Revert them before committing, or
- Split into separate commits (preferred). Only keep the unrelated commit if explicitly requested.

---

### If Tests Cannot Be Run (MANDATORY)

If you cannot run tests for a valid reason (missing env, tool not available):

- Still commit, but include a clear note in the commit body.

Example:

- Subject: `feat(api): implement permit search by address`
- Body: `Notes: tests not run (DB env not available).`

---

### Golden Rule (MANDATORY)

If the diff feels “big,” you waited too long. **Split the work and commit sooner.**

## Architecture Principles

1. **Separation of Concerns**: UI handles presentation only; API handles all business logic and authorization
2. **Same-Origin Hosting**: UI at `/`, API at `/api`, API reference at `/api/docs`
3. **Security by Default**: All API endpoints require authentication unless explicitly public
4. **API-First**: All business logic resides in the API layer

## Key Commands

```bash
# Setup: copy environment template
cp infra/compose/.env.example infra/compose/.env

# Start development (from infra/compose folder)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up

# Start development with observability (Uptrace UI at http://localhost:14318)
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Start production mode
cd infra/compose && docker compose -f base.compose.yml -f prod.compose.yml up

# Run API tests
cd apps/api && npm test

# Run frontend tests
cd apps/web && npm test

# Generate Prisma client after schema changes
cd apps/api && npm run prisma:generate

# Create a new migration (development)
cd apps/api && npm run prisma:migrate:dev -- --name <migration_name>

# Apply migrations (production)
cd apps/api && npm run prisma:migrate

# Note: Use npm scripts (prisma:*) instead of direct npx commands
# They automatically construct DATABASE_URL from individual env vars
```

## Service URLs (Development)

- **Application**: http://localhost:3535 (via Nginx)
- **API Reference (Scalar)**: http://localhost:3535/api/docs
- **Uptrace**: http://localhost:14318 (when otel stack running)

## API Endpoints (MVP)

### Authentication

- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `POST /api/auth/logout-all` - Logout from all devices
- `GET /api/auth/me` - Get current user

### Device Authorization (RFC 8628)

- `POST /api/auth/device/code` - Generate device code (Public)
- `POST /api/auth/device/token` - Poll for authorization (Public)
- `GET /api/auth/device/activate` - Get activation info
- `POST /api/auth/device/authorize` - Approve/deny device
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/{id}` - Revoke device session

### Users (Admin-only)

- `GET /api/users` - List users (paginated)
- `GET /api/users/{id}` - Get user by ID
- `PATCH /api/users/{id}` - Update user (roles, activation)
- `PUT /api/users/{id}/roles` - Update user roles

### Settings

- `GET /api/user-settings` - Get current user's settings
- `PUT /api/user-settings` - Replace user settings
- `PATCH /api/user-settings` - Partial update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Replace system settings (Admin)
- `PATCH /api/system-settings` - Partial update system settings (Admin)

### Allowlist (Admin-only)

- `GET /api/allowlist` - List allowlisted emails (paginated, filterable)
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/{id}` - Remove email from allowlist

### Storage Objects

- `POST /api/storage/objects/upload/init` - Initialize resumable upload
- `GET /api/storage/objects/:id/upload/status` - Get upload progress
- `POST /api/storage/objects/:id/upload/complete` - Complete multipart upload
- `DELETE /api/storage/objects/:id/upload/abort` - Abort upload
- `POST /api/storage/objects` - Simple file upload
- `GET /api/storage/objects` - List objects (paginated)
- `GET /api/storage/objects/:id` - Get object metadata
- `GET /api/storage/objects/:id/download` - Get signed download URL
- `DELETE /api/storage/objects/:id` - Delete object
- `PATCH /api/storage/objects/:id/metadata` - Update metadata

### Personal Access Tokens

- `POST /api/pat` - Create a new personal access token
- `GET /api/pat` - List current user's tokens
- `DELETE /api/pat/{id}` - Revoke a token

### Health

- `GET /api/health/live` - Liveness check
- `GET /api/health/ready` - Readiness check (includes DB)

## RBAC Model

### Roles

- **Admin**: Full access, manage users and system settings
- **Contributor**: Standard capabilities, manage own settings
- **Viewer**: Least privilege (default), manage own settings

### Key Permissions

- `system_settings:read/write` - System settings access
- `user_settings:read/write` - User settings access
- `users:read/write` - User management
- `rbac:manage` - Role assignment
- `allowlist:read/write` - Allowlist management (Admin only)
- `storage:read/write/delete` - Storage object access (own objects)
- `storage:read_any/write_any/delete_any` - Storage object access (all objects, Admin only)

## Database Tables

- `users` - User accounts with profile info
- `user_identities` - OAuth provider identities (provider + subject)
- `roles` / `permissions` / `role_permissions` - RBAC
- `user_roles` - User-to-role assignments
- `system_settings` - Global app settings (JSONB)
- `user_settings` - Per-user settings (JSONB)
- `audit_events` - Action audit log
- `refresh_tokens` - JWT refresh tokens (hashed)
- `allowed_emails` - Allowlist for access control
- `device_codes` - Device authorization codes (RFC 8628)
- `storage_objects` - File metadata, status, storage references
- `storage_object_chunks` - Multipart upload chunk tracking
- `personal_access_tokens` - User-created long-lived API tokens (hashed)

## Access Control: Email Allowlist

The application uses an **email allowlist** to restrict access to pre-authorized users only.

### How It Works

1. Admins add email addresses to the allowlist before users can login
2. During OAuth login, the user's email is checked against the allowlist
3. If the email is not in the allowlist, login is denied with a clear error message
4. Exception: `INITIAL_ADMIN_EMAIL` always bypasses the allowlist check

### Configuration

- `INITIAL_ADMIN_EMAIL` environment variable grants initial admin access
- This email is automatically added to the allowlist during database seeding

### Admin Management

- Access allowlist management at `/admin/users` (Allowlist tab)
- Two tabs available:
  - **Users**: Manage existing registered users
  - **Allowlist**: Pre-authorize email addresses for future logins

### Status Tracking

- **Pending**: Email added to allowlist but user hasn't logged in yet
- **Claimed**: User has successfully logged in and created an account
- Claimed entries cannot be removed (prevents accidentally removing existing user access)

## Security Guidelines

- Secrets via environment variables only (see `.env.example`)
- JWT access tokens are short-lived (15 min default)
- Refresh tokens in HttpOnly cookies with rotation
- Input validation on all endpoints
- File uploads: images only, size/type limits, randomized filenames
- Email allowlist restricts application access to pre-authorized users

## Testing Requirements

- Unit tests: isolated logic (services, guards, validators)
- Integration tests: API + DB + RBAC flows with test DB
- Mock OAuth in CI (no real Google dependency)
- Frontend: component and hook tests

## Environment Variables

Key variables (see `infra/compose/.env.example` for full list):

**Operator-managed settings (epic #332) — read this before editing GitHub,
dispatch, runner, reconciler, supervisor, promotion or notification
variables below.** GitHub, dispatch, the `claude-code-local` runner, the
reconciler, the AI supervisor, the promotion ladder and notifications are
**no longer env-only**. Each of those 39 keys now resolves
`default → env → database row`, with a database row (set from
`/admin/settings` → Configuration) outranking whatever `.env` says — so
editing one of those variables and restarting can appear to do nothing if an
Admin has ever overridden that key from the Control Center. The env value
listed below and in `.env.example` is still real: it is the floor a fresh
install runs on and the fallback if the database overlay is unavailable, but
it is no longer the last word on a deployment that has touched the Control
Center. The three secret keys in that set (`GITHUB_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `SUPERVISOR_MODEL_API_KEY`) are the one exception
still requiring a plain `.env` edit, because the UI that would let an Admin
rotate them from a form (Credentials, #349) has not shipped. See
[`docs/operator-configuration.md`](docs/operator-configuration.md) for the
full resolution order, reload semantics, and what to do if
`OPIFEX_SETTINGS_ENCRYPTION_KEY` is lost. The variables listed below this
point — application, database, JWT/session, OAuth — are unaffected by any of
this; they remain env-only, set once per deployment.

**Application:**

- `NODE_ENV` - Environment (development/production)
- `PORT` - API port (default: 3000)
- `APP_URL` - Base URL (default: http://localhost:3535)

**Database (individual connection parameters):**

- `POSTGRES_HOST` - Database hostname (default: localhost)
- `POSTGRES_PORT` - Database port (default: 5432)
- `POSTGRES_USER` - Database user (default: postgres)
- `POSTGRES_PASSWORD` - Database password (default: `postgres`). **Required and enforced at boot in production only** (#299): the API refuses to start if `NODE_ENV=production` and the value is unset, empty, or still the `postgres` default — that last check is the one that does the work, since `cp infra/compose/.env.example infra/compose/.env` (the setup step above) ships that exact default. Outside production the default applies with no enforcement, deliberately, so `docker compose up` on a laptop stays frictionless. Unlike `JWT_SECRET` there is no minimum length: this is a password an existing database already has, not one generated for the occasion. See `apps/api/src/config/env.validation.ts`.
- `POSTGRES_DB` - Database name (default: appdb)
- `POSTGRES_SSL` - Enable SSL connection (default: false)

Note: `DATABASE_URL` is constructed automatically from these variables at runtime.

**Authentication:**

- `JWT_SECRET` - JWT signing secret. **Required and enforced at boot** (#278): the API refuses to start without one of at least 32 characters, and the startup failure names every invalid variable at once rather than stopping at the first. `openssl rand -base64 32` produces 44 characters, comfortably over the floor. See `apps/api/src/config/env.validation.ts` for why this one variable is a hard startup failure when a missing database (#161) or missing Google credentials (#138) deliberately are not: without a signing secret every authorization decision the process makes is void, so there is nothing left that is safe to serve by staying up.
- `COOKIE_SECRET` - Optional; `main.ts` signs cookies with `COOKIE_SECRET || JWT_SECRET`. When set, it must clear the same 32-character floor as `JWT_SECRET` or the API refuses to start.
- `JWT_ACCESS_TTL_MINUTES` - Access token TTL (default: 15)
- `JWT_REFRESH_TTL_DAYS` - Refresh token TTL (default: 14)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth credentials
- `INITIAL_ADMIN_EMAIL` - First user with this email becomes Admin
- `DEVICE_CODE_EXPIRY_MINUTES` - Device code lifetime (default: 15)
- `DEVICE_CODE_POLL_INTERVAL` - Device polling interval in seconds (default: 5)
- `DEVICE_TOKEN_EXPIRY_DAYS` - Token lifetime for device sessions in days (default: 7)

**Observability:**

- `OTEL_ENABLED` - Enable OpenTelemetry (default: true)
- `OTEL_EXPORTER_OTLP_ENDPOINT` - OTEL Collector endpoint
- `UPTRACE_DSN` - Uptrace connection string

## Common Patterns

### Adding a New API Endpoint

1. Create controller method with decorators for auth/RBAC
2. Add service method with business logic
3. Update OpenAPI annotations
4. Add unit + integration tests
5. Update API.md if needed

### Adding a New Setting

There are two different kinds of "setting" in this codebase, and which one
you are adding decides where it is declared. Adding it in the wrong place —
or adding a second declaration of something the first place already
describes — is the exact mistake epic #332 exists to stop repeating: the
`system_settings` shape it replaced was hand-copied across six files today,
and none of them agreed for long.

**An operator-managed tunable** — a dispatch/runner/reconciler/GitHub/
supervisor/promotion/notification knob an Admin configures for the
deployment, not a per-user preference:

1. Declare it **once**, in
   `apps/api/src/settings/operator-settings/operator-settings.registry.ts` —
   `envVar`, a schema built from one of that file's `*Setting()` helpers,
   `default`, `secret`, `reload`, `group`, `label`, `help` and, if changing it
   can spend money or widen a boundary, `dangerous: true`. The TypeScript
   type is derived from the schema via `z.infer`; do not hand-write a
   parallel type.
2. Delete the corresponding line from `configuration.ts` and its call site —
   `OperatorSettingsService` must become the only way to read this value. A
   key read from both places is the two-sources-of-truth bug this migration
   exists to close, one key at a time (ADR-0018 §1).
3. If the consuming code reads the value more than once per unit of work
   (a tick, a spawn, a request), decide and state which `reload` semantics it
   actually has — `live`, `next-unit`, or `restart` — by reading what the
   consumer does, not by guessing from how the value sounds. See
   `docs/operator-configuration.md`'s worked examples for what separates the
   three.
4. Add it to `.env.example`, annotated like its neighbours: what it does, and
   that it is now a floor/fallback rather than the control surface.
5. Nothing is needed on the frontend. `apps/web/src/components/controlcenter/SettingsSection.tsx`
   and `SettingRow.tsx` render every registry entry from
   `GET /api/operator-settings` with no hand-listed field set — a key added
   to the registry appears on the Control Center's Configuration section with
   the right control, bounds and chips automatically.
6. Add or extend `operator-settings.registry.spec.ts`'s parity assertions and
   the relevant service/controller specs.

**A per-user or application-wide UI preference** — the existing
`user_settings` / `system_settings` JSONB documents (theme, profile,
`ui.allowUserThemeOverride`, feature flags):

1. Update the Zod schema in `apps/api/src/common/schemas/` for validation —
   remembering that file's own rule: no `.default()` on a namespace schema,
   ever, because a persisted default freezes today's value and hides a later
   change to the built-in one from every user who has ever touched an
   unrelated field.
2. Add a migration if the schema's _structure_ changes.
3. Update TypeScript types.
4. Add frontend UI if user-facing — for application-wide policy, that is the
   Control Center's Interface section (`InterfaceSection.tsx`), not
   Configuration.

## Specialized Subagents (MANDATORY)

**CRITICAL REQUIREMENT**: This project uses specialized subagents for all development work. You MUST delegate tasks to the appropriate subagent. Do NOT attempt to perform development tasks directly without using the designated agent.

### Why Subagents Are Mandatory

- Each agent contains domain-specific knowledge from the System Specification
- Agents ensure consistent patterns and conventions across the codebase
- Agents have the full context needed for their specialized area
- Direct implementation without agents risks missing requirements

### Available Agents

Definitions live in [`.claude/agents/`](.claude/agents/) — each file carries the domain conventions, exemplar paths and boundaries for its area.

| Agent          | Model   | Domain                          | MUST Use For                                                                                                            |
| -------------- | ------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `backend-dev`  | inherit | NestJS API, Fastify, auth, RBAC | **ANY** backend code: endpoints, services, guards, middleware, JWT, OAuth                                               |
| `frontend-dev` | inherit | React, MUI, TypeScript          | **ANY** frontend code: components, pages, hooks, theming, responsive design                                             |
| `database-dev` | sonnet  | PostgreSQL, Prisma              | **ANY** database work: schema changes, migrations, seeds, queries                                                       |
| `testing-dev`  | sonnet  | Jest, Supertest, Vitest, RTL    | **ANY** testing: unit tests, integration tests, typecheck, test fixtures                                                |
| `docs-dev`     | sonnet  | Technical documentation         | **ANY** documentation: ARCHITECTURE.md, SECURITY.md, API.md, README updates                                             |
| `ops-dev`      | haiku   | Routine operations              | Rebuilding/restarting containers, running Prisma migrations, running typecheck. NEVER for state-changing git operations |

### Mandatory Delegation Rules

1. **Backend code changes** → ALWAYS use `backend-dev`
2. **Frontend code changes** → ALWAYS use `frontend-dev`
3. **Database/Prisma changes** → ALWAYS use `database-dev`
4. **Writing or updating tests** → ALWAYS use `testing-dev`
5. **Documentation updates** → ALWAYS use `docs-dev`
6. **Routine ops (container rebuilds, migrations, typecheck)** → use `ops-dev`. IMPORTANT: `ops-dev` must NEVER perform state-changing git operations (pull, merge, push, commit, worktree management, branch operations) — those are always handled by the main agent directly, and `ops-dev` is instructed to refuse them

### Multi-Domain Tasks

For tasks spanning multiple domains, you MUST invoke multiple agents sequentially:

**Example: "Add a new user preference setting"**

1. `database-dev` → Add migration for schema change
2. `backend-dev` → Implement API endpoint
3. `frontend-dev` → Build UI component
4. `testing-dev` → Write tests for all layers
5. `docs-dev` → Update API documentation

### Usage Examples

```
# Backend work - MUST use backend-dev
"Use backend-dev to implement the user settings endpoint"

# Frontend work - MUST use frontend-dev
"Use frontend-dev to create the theme toggle component"

# Database work - MUST use database-dev
"Use database-dev to add audit_events table migration"

# Testing work - MUST use testing-dev
"Use testing-dev to write integration tests for auth"

# Documentation work - MUST use docs-dev
"Use docs-dev to update SECURITY.md with new auth flow"

# Routine ops - use ops-dev (never for git operations)
"Use ops-dev to rebuild the api container and run migrations"
```

### What You Should NOT Do Directly

- Do NOT write NestJS controllers, services, or guards without `backend-dev`
- Do NOT create React components or pages without `frontend-dev`
- Do NOT modify Prisma schema or create migrations without `database-dev`
- Do NOT write Jest/RTL tests without `testing-dev`
- Do NOT update documentation files without `docs-dev`

The only exceptions are:

- Reading files to understand context
- Answering questions about the codebase
- Planning and coordination between agents
- Running simple commands (git status, npm install, etc.)
