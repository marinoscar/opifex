# =============================================================================
# API Dockerfile - Multi-stage build
# =============================================================================
# IMPORTANT: the build context is the REPOSITORY ROOT, not apps/api.
#
# apps/api is an npm workspace member and has no lockfile of its own; the only
# package-lock.json lives at the repo root. Building from the root is what
# makes that lockfile visible to the builder, so every stage can install with
# `npm ci` instead of `npm install`. Without this, each image build re-resolves
# the whole dependency tree and can ship versions that differ from what CI
# tested.
#
#   docker build -f apps/api/Dockerfile .
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:24-alpine AS base
WORKDIR /app
# Install OpenSSL for Prisma compatibility
RUN apk add --no-cache openssl openssl-dev

# -----------------------------------------------------------------------------
# The runner's two binaries (#325)
# -----------------------------------------------------------------------------
# ADR-0008 makes `claude-code-local` a CHILD PROCESS of the API process, so
# "where Opifex runs" and "where Claude Code runs" are the same container by
# construction. Both binaries must be on this image's PATH, or the runner
# registers itself unavailable and every work order queues behind it.
#
# `git` is the blocker that fires FIRST, and it is the less obvious of the two.
# RunWorkspaceService shells out to it for clone, checkout, `git config` and
# commit, so a run dies at workspace provisioning before the CLI is ever
# invoked. Installing only `claude` would move the failure, not fix it.
#
# Installed here in `base` rather than repeated in `development` and
# `production`, and the trade-off is deliberate. Repeating the install caches
# better -- a CLI bump would not invalidate the deps stage's `npm ci` -- but it
# lets the two images drift to different CLI versions, and the capability
# manifest records the OBSERVED version as a fact about the fleet. Two
# environments quietly disagreeing about which agent version did the work is a
# worse problem than a slower rebuild.
RUN apk add --no-cache git

# Unpinned by default, which is defensible only because the version is OBSERVED
# rather than assumed: `probeVersion()` runs `claude --version` and the
# registration tick writes what it actually reported into `runner_capabilities`,
# so drift surfaces in the fleet instead of silently changing what does the
# work. A deployment that wants a reproducible image pins it:
#
#   docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.246 api
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Copy manifests first so this layer caches on dependency changes only.
# Every workspace manifest is required: `npm ci` validates the whole workspace
# set against the lockfile, even when installing a single workspace.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
# Prisma schema and config are needed by `prisma generate` below
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/
RUN npm ci --workspace=api --include-workspace-root --ignore-scripts
# --ignore-scripts skips Prisma's postinstall, so generate the client
# explicitly. DATABASE_URL is a build-time placeholder; `generate` reads the
# schema only and never opens a connection.
RUN cd apps/api && \
    DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
# Brings node_modules from both the root and the workspace, plus the manifests
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY scripts ./scripts
# Root-level JSON Schemas (e.g. run-event.schema.json), read at runtime by
# RunEventValidator via a path resolved relative to /app.
COPY schemas ./schemas
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM base AS production
COPY --from=deps /app ./
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/
COPY scripts ./scripts
# Root-level JSON Schemas (e.g. run-event.schema.json), read at runtime by
# RunEventValidator via a path resolved relative to /app.
COPY schemas ./schemas
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
