# System Specification Document
**Project:** Web Application Foundation (React UI + Node API + PostgreSQL)  
**Version:** 1.0  
**Audience:** Engineering team (Frontend, Backend, DevOps/Platform, QA)

---

## 1. Purpose and Scope

### 1.1 Purpose
Build a production-grade web application foundation that establishes:
- Secure authentication via OAuth (Google required; Microsoft and other providers supported by design)
- API-first architecture where all business logic resides in the API
- Role-based access control (RBAC) for authorization
- A flexible settings framework (system settings + user settings) stored as JSON for extensibility
- Strong engineering hygiene: migrations, testing, observability, logging, documentation, Dockerized local environment

### 1.2 Scope (MVP)
The MVP includes:
- Login via Google OAuth
- Minimal UI shell: login page, empty home page, user settings page (theme + profile overrides), system settings page (admin-only), logout
- Secure API with JWT protection
- PostgreSQL schema for users, identities, RBAC, settings, and audit logging (recommended)
- Migrations and versioned schema changes
- Unit and integration test frameworks for frontend and backend
- OpenAPI specification with Swagger UI
- OpenTelemetry instrumentation and structured logging
- Docker Compose-based local development environment

### 1.3 Out of Scope (for MVP)
- Complex feature workflows beyond settings and auth
- Advanced admin UI for permissions management beyond basic role assignment
- Multi-tenant isolation (can be added later)
- Production deployment infrastructure (Kubernetes/Cloud) not required for MVP but should be design-compatible

---

## 2. Architecture Principles

### 2.1 Separation of Concerns
- Frontend: user interaction and presentation only
- API: all business logic, authorization enforcement, data access
- Database: accessed only by API

### 2.2 Same-Origin Hosting
UI and API share the same base URL:
- UI: `/`
- API: `/api` (versioned routing recommended)
- Swagger: `/api/docs`
- OpenAPI JSON: `/api/openapi.json`

### 2.3 Security by Default
- All API endpoints require authentication unless explicitly marked public
- Authorization checks are mandatory for sensitive endpoints
- Secrets are never committed; environment variables only

### 2.4 Observability and Operability
Enterprise-grade instrumentation required from day one:
- Traces, metrics, logs must be structured, correlated, and exportable via OpenTelemetry

---

## 3. Technology Stack

### 3.1 Mandated Stack
- Backend: Node.js + TypeScript
- Frontend: React + TypeScript
- UI library: Material UI (MUI)
- Database: PostgreSQL
- Containerization: Docker + Docker Compose (Docker Desktop compatible)

### 3.2 Recommended Framework Choices
**Backend framework:** NestJS with Fastify adapter  
**Database ORM + migrations:** Prisma  
**Auth:** Passport strategies (Google required; Microsoft optional)  
**Testing:**
- Backend: Jest + Supertest
- Frontend: Vitest + React Testing Library
- Optional E2E: Playwright  
**Observability:** OpenTelemetry Node SDK + auto-instrumentations  
**Logging:** Pino structured JSON logs (recommended)

---

## 4. Repository and Project Structure

### 4.1 Monorepo Layout (Recommended)
```
/
  apps/
    api/
      src/
      test/
      prisma/
        schema.prisma
        migrations/
      Dockerfile            # API container (near its code)
    web/
      src/
      src/__tests__/        # or colocated tests
      Dockerfile            # Web container (near its code)
  docs/
    ARCHITECTURE.md
    SECURITY.md
    OBSERVABILITY.md
    API.md                  # optional but recommended
    SPEC.md                 # this document
  infra/
    compose/
      base.compose.yml       # Core services: api, web, db, nginx
      dev.compose.yml        # Development overrides (hot reload, volumes)
      prod.compose.yml       # Production overrides (resource limits)
      otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
      .env.example           # Environment variables template
    nginx/
      nginx.conf            # Nginx routing configuration
    otel/
      otel-collector-config.yaml   # OTEL Collector config
      uptrace.yml                  # Uptrace configuration
  tests/
    e2e/                    # optional full-system tests
  README.md
```

### 4.2 Documentation Folder (Mandatory)
`/docs` must include:
- `ARCHITECTURE.md` (required)
- `SECURITY.md`
- `OBSERVABILITY.md`
- `SPEC.md` (this spec)
- `API.md` (recommended)

---

## 5. User Experience (MVP UI Requirements)

### 5.1 Pages and Navigation
UI must provide:

**A) Login Page**
- Displays configured OAuth providers (minimum Google)
- Clicking provider redirects browser to API auth initiation endpoint

**B) Home Page (Post-login)**
- Minimal placeholder content
- Displays user card: email, display name, profile image

**C) User Settings Page**
- Theme: Light / Dark / System
- Profile settings:
  - Email read-only
  - Display name editable (override)
  - Profile image: provider image default + ability to upload custom image and choose which to use
- Persist via API endpoints + DB

**D) System Settings Page (Admin-only)**
- View/edit system settings stored as JSON
- MVP can use JSON editor with validation
- Non-admins forbidden

**E) Logout**
- Terminates session on client and server (token invalidation strategy below)

### 5.2 Responsive Design
- Must render well on desktop and mobile
- Use MUI responsive components and theme breakpoints

---

## 6. Authentication and Session Management

### 6.1 OAuth Provider Requirements
- Required: Google OAuth 2.0 / OIDC
- Designed to support additional providers via configuration:
  - Microsoft (Entra ID) recommended
  - Future: GitHub, Okta, etc.

Provider config is environment-driven:
- Client ID
- Client secret
- Callback base URL
- Provider enabled/disabled flags

### 6.2 Identity and User Record Rules
- Capture email from provider claims
- Email is unique identity key (MVP)
- First login:
  - Create user
  - Assign default role (recommended Viewer)
  - Store provider identity record (provider + subject/sub)
  - Store provider display name + provider image URL
- Subsequent logins:
  - Match by provider identity (preferred) or email (acceptable MVP)
  - Update provider fields; do not overwrite user overrides

### 6.3 User Override Fields
User may override:
- Display name
- Profile image (upload)

Effective fields:
- Display name: `display_name` if set else `provider_display_name`
- Profile image: custom if enabled else provider image

### 6.4 JWT Requirements
- JWT required for all protected endpoints
- Access token short-lived (recommended 10–20 minutes)
- JWT includes:
  - user id
  - roles (and optionally permissions)
- Signing:
  - MVP: HS256 with strong secret
  - Recommended enterprise: RS256 private/public keys

### 6.5 Refresh Token Strategy (Strongly Recommended)
- Refresh token stored in HttpOnly cookie (Secure + SameSite)
- Rotation + server-side invalidation on logout

Endpoints:
- `POST /api/auth/refresh`
- `POST /api/auth/logout`

If cookies are used:
- Add CSRF mitigations (origin checks + SameSite, optional CSRF token)

---

## 7. Authorization (RBAC)

### 7.1 Roles (Minimum)
- Admin: manage users and system settings
- Contributor: standard capabilities (future expansion); manage own settings
- Viewer: least privilege; manage own settings based on policy

Default role: Viewer

### 7.2 Permission Model (Recommended)
Permissions are strings mapped to roles:
- `system_settings:read`
- `system_settings:write`
- `user_settings:read`
- `user_settings:write`
- `users:read`
- `users:write`
- `rbac:manage`

Admin: all  
Contributor/Viewer: limited subsets

### 7.3 Enforcement Rules
- Every protected endpoint declares required roles/permissions
- System settings write is Admin-only
- User settings endpoints scoped to authenticated user
- User admin endpoints Admin-only

---

## 8. API Design and Endpoints

### 8.1 Base Paths and Versioning
- Base: `/api`
- Recommended internal versioning: `/api/v1`
- `/api` may alias to `/api/v1` for MVP

### 8.2 Response Standards
Consistent success/error format:
- Success includes `data` + optional `meta`
- Error includes `code`, `message`, optional `details`

### 8.3 Required Endpoints (MVP)

**Authentication**
- `GET /api/auth/providers`
- `GET /api/auth/google`
- `GET /api/auth/google/callback`
- `POST /api/auth/refresh` (if refresh tokens used)
- `POST /api/auth/logout`
- `GET /api/auth/me`

**Users (Admin-only)**
- `GET /api/users` (paginated)
- `GET /api/users/{id}`
- `PATCH /api/users/{id}` (roles, activation)
- `POST /api/users/{id}/profile-image` (upload custom image)

**User Settings**
- `GET /api/user-settings`
- `PUT /api/user-settings` (replace full JSON)
- `PATCH /api/user-settings` (partial update; JSON Merge Patch recommended)

**System Settings**
- `GET /api/system-settings`
- `PUT /api/system-settings`
- `PATCH /api/system-settings`

**Health**
- `GET /api/health/live`
- `GET /api/health/ready`

**OpenAPI and Swagger**
- `GET /api/openapi.json`
- `GET /api/docs`

### 8.4 OpenAPI Requirements
OpenAPI spec must:
- Be generated from code annotations
- Accurately describe auth (JWT bearer)
- Include schemas for requests/responses/errors
- Document RBAC requirements per endpoint (description or extensions)

---

## 9. Database Design (PostgreSQL)

### 9.1 Requirements
- Tables for users, identities, RBAC, user settings, system settings
- JSONB for settings
- UUID primary keys
- `timestamptz` timestamps
- Managed with migrations

### 9.2 Recommended Tables

**users**
- id (uuid pk)
- email (text unique not null)
- display_name (text null)
- provider_display_name (text null)
- profile_image_url (text null)
- provider_profile_image_url (text null)
- is_active (boolean default true)
- created_at, updated_at (timestamptz)

**user_identities**
- id (uuid pk)
- user_id (uuid fk users.id)
- provider (text)
- provider_subject (text)
- provider_email (text null)
- created_at (timestamptz)
Unique: (provider, provider_subject)

**roles**
- id (uuid pk)
- name (text unique)
- description (text)

**permissions**
- id (uuid pk)
- name (text unique)
- description (text)

**role_permissions**
- role_id (uuid fk)
- permission_id (uuid fk)
PK: (role_id, permission_id)

**user_roles**
- user_id (uuid fk)
- role_id (uuid fk)
PK: (user_id, role_id)

**system_settings**
- id (uuid pk)
- key (text unique) e.g. `global`
- value (jsonb not null)
- version (int default 1)
- updated_by_user_id (uuid fk users.id null)
- updated_at (timestamptz)

**user_settings**
- id (uuid pk)
- user_id (uuid unique fk users.id)
- value (jsonb not null)
- version (int default 1)
- updated_at (timestamptz)

**audit_events** (recommended)
- id (uuid pk)
- actor_user_id (uuid fk users.id null)
- action (text)
- target_type (text)
- target_id (text/uuid)
- meta (jsonb)
- created_at (timestamptz)

### 9.3 Settings JSON Shapes (Recommended)
User settings example:
```json
{
  "theme": "light | dark | system",
  "profile": {
    "displayName": "string",
    "useProviderImage": true,
    "customImageUrl": "string | null"
  }
}
```

System settings example:
```json
{
  "ui": {
    "allowUserThemeOverride": true
  },
  "security": {
    "jwtAccessTtlMinutes": 15,
    "refreshTtlDays": 14
  },
  "features": {
    "exampleFlag": false
  }
}
```

### 9.4 JSON Validation
- Validate settings JSON with runtime schema validation (recommended: Zod)
- Reject invalid payloads
- Enforce theme enums
- Allow forward-compatible extra fields as policy dictates

---

## 10. Migrations and Version Management

### 10.1 Migration Ownership
- Migrations belong to API (`apps/api/prisma/migrations`)

### 10.2 Rules
- Every schema change requires a migration
- Migrations committed to source control
- CI verifies migration/schema sync

### 10.3 Seeding
Seed:
- Roles (Admin/Contributor/Viewer)
- Permissions
- Role-permission mappings
- system_settings row (`key=global`) with defaults

Initial Admin bootstrap:
- Recommended: `INITIAL_ADMIN_EMAIL` env var; first login matching becomes Admin

---

## 11. Security Requirements

### 11.1 Secrets
- Environment variables only
- `.env.example` required

### 11.2 Transport Security
- HTTPS required in production
- Local dev HTTP acceptable

### 11.3 API Security Controls
- Input validation everywhere
- Rate limiting (auth + sensitive writes)
- Security headers (helmet)
- Strict CORS (same-origin by default)
- Consistent error handling (no stack traces to client)

### 11.4 JWT Controls
- Short-lived access tokens
- Refresh token rotation (recommended)
- Invalidate on logout
- Disabled users lose access immediately (server checks)

### 11.5 RBAC Controls
- Least privilege defaults
- Admin assignment explicit
- Server-side enforcement only (UI is not security)

### 11.6 File Upload Security
- Only images allowed
- Size/type limits
- Randomized filenames
- Controlled static serving
- Optional future: malware scanning, external storage

### 11.7 Audit (Recommended)
- Persist admin actions: settings changes, role changes, user deactivation

---

## 12. Observability Requirements (OpenTelemetry)

### 12.1 Required Signals
- Traces: HTTP, DB, auth
- Metrics: request count, duration, error rates, process metrics
- Logs: structured JSON, correlated to traces

### 12.2 Correlation
- Generate/propagate request_id
- Include trace_id/span_id in logs when available

### 12.3 Export
- OTLP export to OpenTelemetry Collector in Docker Compose
- Collector exports to Jaeger (traces)
- Optional Prometheus + Grafana

### 12.4 Health
- Liveness + readiness endpoints
- Readiness checks DB connectivity

---

## 13. Testing Requirements

### 13.1 Strategy
- Unit tests: isolated logic
- Integration tests: API + DB + RBAC
- Frontend tests: components + hooks
- Optional E2E: full system via Docker Compose

### 13.2 Backend Tests
- Unit: services, guards, validators
- Integration:
  - Run migrations against test DB
  - Test auth/me, settings, RBAC protections
  - Mock OAuth flows in CI (do not depend on real Google)

### 13.3 Frontend Tests
- Login provider rendering
- Theme toggle and persistence interactions
- Settings save and error states
- Logout behavior

### 13.4 CI Quality Gates (Minimum)
- Lint
- Typecheck
- Unit tests
- Integration tests
- Migration consistency check
- Optional: docker build

---

## 14. Docker and Local Development

### 14.1 Hybrid Docker Structure
Dockerfiles stay with their application code for natural build context, while compose orchestration and infrastructure configs live in `/infra`:

**Dockerfiles (with code):**
- `apps/api/Dockerfile` - API container definition
- `apps/web/Dockerfile` - Web container definition

**Infrastructure directory:**
```
infra/
  compose/
    base.compose.yml       # Core services: api, web, db, nginx
    dev.compose.yml        # Development overrides (hot reload, volumes)
    prod.compose.yml       # Production overrides (resource limits)
    otel.compose.yml       # Observability: uptrace, clickhouse, otel-collector
    .env.example           # Environment variables template
  nginx/
    nginx.conf                   # Nginx routing (/ → web, /api → api)
  otel/
    otel-collector-config.yaml   # OTEL Collector exports to Uptrace
    uptrace.yml                  # Uptrace configuration
```

### 14.2 Docker Compose Services

**Core services (docker-compose.yml):**
- `nginx` - Reverse proxy (same-origin routing)
- `api` - NestJS backend
- `web` - React frontend
- `db` - PostgreSQL database

**Observability services (docker-compose.otel.yml):**
- `otel-collector` - Collects traces, metrics, logs
- `uptrace` - Unified observability UI
- `clickhouse` - Uptrace storage backend

### 14.3 Environment Variables
Environment variables are defined in `infra/compose/.env.example`:

```bash
# ===================
# Application
# ===================
NODE_ENV=development
PORT=3000
APP_URL=http://localhost

# ===================
# Database (PostgreSQL)
# ===================
DATABASE_URL=postgresql://postgres:postgres@db:5432/appdb
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=appdb

# ===================
# JWT / Session
# ===================
JWT_SECRET=your-super-secret-key-min-32-characters-long
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=14

# ===================
# OAuth - Google (Required)
# ===================
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3535/api/auth/google/callback

# ===================
# OAuth - Microsoft (Optional)
# ===================
# MICROSOFT_ENABLED=false
# MICROSOFT_CLIENT_ID=
# MICROSOFT_CLIENT_SECRET=
# MICROSOFT_CALLBACK_URL=http://localhost:3535/api/auth/microsoft/callback

# ===================
# Initial Admin Bootstrap
# ===================
INITIAL_ADMIN_EMAIL=admin@example.com

# ===================
# Observability (OpenTelemetry)
# ===================
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_SERVICE_NAME=enterprise-app-api
LOG_LEVEL=info

# ===================
# Uptrace (when using docker-compose.otel.yml)
# ===================
UPTRACE_DSN=http://project1_secret_token@localhost:14317/1
```

Copy to `.env` and customize:
```bash
cp infra/compose/.env.example infra/compose/.env
```

### 14.4 Running Docker Compose
Run commands from the `infra/compose` folder where `.env` is located:

```bash
cd infra/compose

# Development (hot reload, volumes, exposed ports)
docker compose -f base.compose.yml -f dev.compose.yml up

# Development with observability (Uptrace UI at http://localhost:14318)
docker compose -f base.compose.yml -f dev.compose.yml -f otel.compose.yml up

# Production (resource limits, restart policies)
docker compose -f base.compose.yml -f prod.compose.yml up
```

### 14.5 Service URLs (Development)
- **Application**: http://localhost:3535 (via Nginx)
- **API directly**: http://localhost:3000 (dev only, not via Nginx)
- **Swagger UI**: http://localhost:3535/api/docs
- **Uptrace**: http://localhost:14318 (when otel stack running)

### 14.6 Startup (Dev vs Prod)
- Dev can auto-run migrations on startup
- Prod should run migrations as a separate step/job

---

## 15. Frontend Security and Session Handling

### 15.1 Token Storage
Preferred:
- Access token in memory
- Refresh token in HttpOnly cookie
Avoid:
- Long-lived tokens in localStorage

### 15.2 XSS and CSP
- Use CSP headers where possible
- Avoid unsafe HTML injection

---

## 16. Deliverables

Team must deliver:
- Running app via Docker Compose
- UI pages per MVP
- API endpoints per MVP secured by JWT
- RBAC enforcement
- Postgres schema + migrations + seeds
- OpenAPI spec + Swagger UI
- OpenTelemetry instrumentation + local viewing (Jaeger)
- Unit + integration tests + scripts
- `/docs` with required documents

---

## 17. Acceptance Criteria (MVP)

MVP is accepted when:
- Developer can run `docker compose up` after setting env vars
- User can login with Google OAuth
- API issues JWT access token (and refresh if implemented)
- `/api/auth/me` works for authenticated user
- User settings (theme/profile) persist in DB and reload on refresh
- Admin can edit system settings; non-admin cannot
- Roles exist and default assignment is least privilege
- Migrations apply cleanly from empty DB
- Swagger UI is available and accurate
- OpenTelemetry traces/log correlation works locally
- Tests run successfully (unit + integration minimum)

---

## Checklist of Coverage

### A) Architecture and Scope
- [ ] Purpose and MVP scope defined
- [ ] Principles: UI-only frontend, logic-only API, same-origin hosting
- [ ] Same URL routing for UI/API/Swagger/OpenAPI

### B) Technology Decisions
- [ ] Mandated stack (Node/TS, React, Postgres, Docker)
- [ ] Recommended frameworks (NestJS+Fastify, Prisma, Passport, MUI, OpenTelemetry, Pino)
- [ ] Testing tools (Jest/Supertest, React Testing Library, optional Playwright)

### C) UI Requirements (MVP)
- [ ] Login page with Google OAuth
- [ ] Empty home page placeholder
- [ ] User settings (theme, display name override, profile image override)
- [ ] Admin-only system settings JSON editor
- [ ] Logout
- [ ] Responsive design requirement (desktop + mobile)

### D) Auth and Security
- [ ] OAuth provider requirements + env-based configuration
- [ ] Identity rules and user provisioning
- [ ] JWT requirements (claims, TTL, signing)
- [ ] Refresh token approach (recommended) + logout invalidation
- [ ] Secrets via environment variables
- [ ] Rate limiting, helmet, CORS, validation, upload security
- [ ] Least privilege RBAC rules

### E) RBAC
- [ ] Roles: Admin, Contributor, Viewer
- [ ] Permission model recommended (role-permission mapping)
- [ ] Enforcement rules by endpoint

### F) API Specification
- [ ] Endpoint list for auth, users, settings, health
- [ ] OpenAPI + Swagger UI requirements and paths
- [ ] Standard response/error conventions
- [ ] Versioning guidance

### G) Database and Migrations
- [ ] Postgres tables for users, identities, roles, permissions, settings
- [ ] JSONB storage for system/user settings
- [ ] Settings shapes + server-side validation
- [ ] Migration location/rules + seeding + admin bootstrap

### H) Observability
- [ ] OpenTelemetry traces/metrics/logs requirements
- [ ] Trace/log correlation requirements
- [ ] Local OTEL collector + Jaeger recommended
- [ ] Liveness/readiness endpoints

### I) Testing
- [ ] Unit + integration tests for API
- [ ] Frontend component tests
- [ ] OAuth mocking guidance for CI
- [ ] Optional E2E structure
- [ ] CI quality gates

### J) Docker and Docs
- [ ] Docker Compose services
- [ ] `.env.example` requirement
- [ ] `/docs` folder requirement and doc types
- [ ] Acceptance criteria defined
