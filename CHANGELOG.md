# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Contracts**: `schemas/work-order.schema.json`, `schemas/runner-capability.schema.json` and `schemas/run-event.schema.json`, with worked examples, invalid fixtures and a conformance suite that asserts each fixture is rejected for the reason it was written for.
- **Contract types**: TypeScript generated from the three schemas by `npm run contracts:generate` into both `apps/api` and `apps/web`, so the cockpit and the API cannot disagree about a shape. `npm run contracts:check` fails the build when a schema changes and the generated output does not.
- **Boundary validation**: work orders are validated before they become an authorization record and an execution record, capability manifests before a runner enters the fleet, and run events at ingestion. Failures name the offending field.
- **Schema versioning**: `schemaVersion` accepts the whole `1.x` range with `default` naming the version a producer should write; one schema file per major, and the old file stays so a persisted work order remains re-runnable. Policy recorded as ADR-0010.
- **OpenAPI**: `npm run openapi:dump` and `npm run openapi:lint` are wired and enforced in CI against a Spectral ruleset; the document is generated rather than committed.
- **CI**: GitHub Actions pipeline (`.github/workflows/ci.yml`) with `provenance`, `lint`, `typecheck`, `test-api`, `test-web`, and `build` jobs, running on pull requests and pushes to `main`. `provenance` is pull-request-only, since a push to `main` has no PR body to carry a closing keyword.
- **Provenance enforcement**: `scripts/check-provenance.mjs` fails a pull request whose body carries no closing keyword, whose commits are missing a required trailer, or that names a decision resolving to no file under `docs/adr/`. Its patterns are read out of `docs/PROVENANCE.md` at run time so the check and the specification cannot drift.
- **Architecture decision records**: `docs/adr/` with a template, an index, and the numbering, lifecycle and supersession conventions (`docs/adr/README.md`); recorded as ADR-0009. Every ADR names its discussion issue, and CI enforces it.
- **Linting and formatting**: ESLint (flat config) and Prettier across both workspaces, replacing the `echo 'No linter configured'` stubs. `npm run lint` and `npm run format:check` are real and CI blocks on both.
- **Dependency updates**: Dependabot configuration (`.github/dependabot.yml`) for weekly npm updates across the root, `apps/api`, and `apps/web` workspaces, plus weekly GitHub Actions updates.
- **Governance**: GitHub issue templates (Epic, Feature request, Bug report, Decision proposal), a pull request template with required provenance trailers, a machine-readable label taxonomy (`.github/labels.yml`), and `.github/CODEOWNERS`.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 22.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication

- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)

- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization

- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control

- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management

- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework

- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API

- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend

- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool

- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure

- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability

- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing

- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library

### API Endpoints

#### Authentication

- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `GET /api/auth/me` - Get current user

#### Device Authorization

- `POST /api/auth/device/code` - Generate device code
- `POST /api/auth/device/token` - Poll for authorization
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/:id` - Revoke device session

#### Users (Admin only)

- `GET /api/users` - List users (paginated)
- `GET /api/users/:id` - Get user by ID
- `PATCH /api/users/:id` - Update user

#### Allowlist (Admin only)

- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove from allowlist

#### Settings

- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Update system settings (Admin)

#### Health

- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

### Technical Stack

- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx
