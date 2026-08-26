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

# `util-linux`, for `script(1)` — the only pty this image has (#386).
#
# `claude setup-token` REFUSES to run without a terminal: with stdin on a pipe
# it dies with `the input device is not a TTY`, prints no authorize URL, and
# exits. The API process has no terminal of its own and never will — it is
# started by an init system, not a shell — so "just spawn it" cannot work here.
#
# Node has no pty. The two ways to get one are `node-pty`, a native addon that
# drags a full compiler toolchain into this image and has to be rebuilt for
# every Node bump, and `script -qec "<cmd>" /dev/null`, which allocates a pty
# in about a millisecond and is a 2 MB package. Verified from inside this
# container, spawned from a parent with no TTY at all: the second one captures
# the authorize URL correctly. So this is that package.
#
# Alpine currently pulls `util-linux-misc` in as a transitive dependency, which
# is exactly why it is named here explicitly rather than left to luck: an
# incidental dependency that disappears in a base-image bump would take the
# Connect-your-Claude-account flow with it, and the failure would surface as
# `ENOENT: script` on an operator's first click.
RUN apk add --no-cache util-linux

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
# Every `npm run prisma:*` script (migrate, seed, generate, push, studio) and
# `check:prisma-fields` shells out to `scripts/prisma-env.js`, relative to
# apps/api/ -- not the root `scripts/` copied below, which is a different
# directory entirely. The `development` stage never had this bug: it copies
# `apps/api` wholesale (see above) and brings its scripts along for free.
# `production` copies selectively and missed this one, so `docker compose
# exec api npm run prisma:migrate` -- the documented ops flow -- failed at
# module resolution before Prisma ever ran (#382).
COPY apps/api/scripts ./apps/api/scripts
COPY scripts ./scripts
# Root-level JSON Schemas (e.g. run-event.schema.json), read at runtime by
# RunEventValidator via a path resolved relative to /app.
COPY schemas ./schemas
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
