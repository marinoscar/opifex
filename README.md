# Opifex

**AI Software Factory**

Opifex is a control plane that turns GitHub issues into work orders,
dispatches them to coding-agent runners, watches those runs continuously,
recovers from what is recoverable, escalates what is not, and writes the
complete record of what happened back into GitHub. It is built on, and ships
with, a production-grade web application foundation — OAuth authentication,
RBAC, and a Postgres/Prisma data layer — that the factory's cockpit and every
control-plane module run inside.

Most of the control plane defaults to off. The code exists and is tested;
whether it is dispatching real work on a given deployment is a separate,
operational decision — see [`docs/RUNBOOK-observation-week.md`](docs/RUNBOOK-observation-week.md).

## Repository shape

```
apps/
  api/       NestJS + Fastify backend — the control plane and the foundation API
  web/       React + MUI frontend, including the cockpit
docs/        Architecture, security, testing, deployment, and the ADR log
infra/       Docker Compose stacks, nginx, observability config
schemas/     JSON Schemas for work orders, runner capabilities, run events
.github/     Issue templates, CI, the provenance check, label taxonomy
```

## Running it

```bash
cp infra/compose/.env.example infra/compose/.env
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up
```

The application is served at http://localhost:3535, the API reference at
http://localhost:3535/api/docs. That port is the default; it's set by
`NGINX_PORT` in `infra/compose/.env` (see `docs/ssl-nginx-setup.md`), so a
given deployment may publish elsewhere.

## Where to go next

| Question                                       | Document                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Why does Opifex exist, and what is it not?     | [`VISION.MD`](VISION.MD)                                               |
| What is the structure, and where does it live? | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                         |
| Why was a specific design chosen?              | [`docs/adr/`](docs/adr/)                                               |
| How do I turn the factory on and operate it?   | [`docs/RUNBOOK-observation-week.md`](docs/RUNBOOK-observation-week.md) |
| How do commits and PRs stay traceable?         | [`docs/PROVENANCE.md`](docs/PROVENANCE.md)                             |
| How does an AI agent work in this codebase?    | [`CLAUDE.md`](CLAUDE.md)                                               |
| What changed recently?                         | [`CHANGELOG.md`](CHANGELOG.md)                                         |
