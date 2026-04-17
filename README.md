# Princeton Sentinel

Princeton Sentinel is a Microsoft 365 posture and operations platform built around three services: a Next.js web app for dashboards and admin workflows, a Python worker for ingestion and job execution, and Postgres for inventory, audit history, and materialized-view reporting.

The top-level README is the repo entrypoint. It summarizes what is in the repository today and links to the deeper component docs:

- [WEB-README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/WEB-README.md)
- [WORKER-README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/WORKER-README.md)
- [DB-README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/DB-README.md)
- [scripts/README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/README.md)

## Architecture

- `postgres:16`
  System of record for Graph inventory tables, schedules, run history, audit logs, feature flags, license state, and materialized views.
- `web/`
  Next.js 16 app that handles sign-in, route protection, dashboards, admin UI, license management, schedule management, worker proxy routes, and live Graph drill-down/revoke actions.
- `worker/`
  Python 3.11 Flask service, served by Gunicorn, that runs the in-process scheduler, Microsoft Graph ingestion, materialized view refreshes, Copilot telemetry ingestion, Conditional Access actions, and the worker heartbeat.

## What Is In The Repo

- [`web/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web)
  App Router UI plus API routes.
- [`worker/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker)
  Scheduler, ingestion jobs, internal API, and worker tests.
- [`db/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db)
  Bootstrap schema, init SQL, and forward migrations.
- [`scripts/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts)
  Local migration helper, license generator, CI packaging, and Azure deployment automation.
- [`docker-compose.yml`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/docker-compose.yml)
  Local three-service development stack.
- [`.env.example`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.example)
  Local runtime configuration template.
- [`.env.github.example`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.github.example)
  GitHub Actions staging configuration template.

## Current Product Surface

The repository now covers more than the original dashboard-only flow. The current web surface includes:

- user dashboards for overview, SharePoint sites, activity, sharing, risk, users, and groups
- site and item drill-down pages that combine cached Postgres data with live Graph checks
- admin pages for analytics, revoke activity, agent access logs, jobs, runs, worker overview, and license management
- an agents section with Dataverse-backed access control and Copilot telemetry views
- feature flags for `agents_dashboard` and Graph sync `test_mode`
- a local Docker-only `/testing` page for license emulation controls

The top-level shortcuts `/analytics`, `/jobs`, and `/runs` currently redirect to the corresponding `/admin/*` pages.

## Quick Start

1. Copy [`.env.example`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.example) to `.env`.
2. Fill in the required Entra and security values:
   - `ENTRA_TENANT_ID`
   - `ENTRA_CLIENT_ID`
   - `ENTRA_CLIENT_SECRET`
   - `ADMIN_GROUP_ID`
   - `USER_GROUP_ID`
   - `WORKER_INTERNAL_API_TOKEN`
   - `WORKER_HEARTBEAT_TOKEN`
3. Start the local stack:

```bash
docker compose up --build
```

4. Open [http://localhost:3000](http://localhost:3000) and sign in with an Entra user in the configured admin or user group.

## Local Development Notes

- The Compose stack sets `LOCAL_DOCKER_DEPLOYMENT=true` for `web` and `worker`.
- On a fresh local database, the app seeds:
  - jobs: `graph_ingest`, `mv_refresh`, `copilot_telemetry`
  - schedules: `mv_refresh` enabled every 5 minutes, `copilot_telemetry` enabled every 60 minutes, and no default schedule for `graph_ingest`
  - feature flags: `agents_dashboard=true`, `test_mode=false`
- Local Docker also exposes the `/testing` page. The seeded local testing state starts with license emulation enabled, which produces a synthetic full-feature license until you turn it off.
- Postgres init scripts in [`db/init/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init) run only when the database volume is created for the first time. After that, apply incremental SQL from [`db/migrations/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/migrations) with [`scripts/db_migrations.py`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/db_migrations.py) or recreate the local volume.

## Entra And External Dependencies

- A single Entra app registration is shared by `web` and `worker`.
- Authorization is group-based and uses the `groups` claim from the ID token.
- The app does not perform Graph group overage resolution. If Entra replaces `groups` with `_claim_names`, access is denied.
- The worker API is internal-only and is protected by `WORKER_INTERNAL_API_TOKEN`.
- The worker heartbeat endpoint is protected by `WORKER_HEARTBEAT_TOKEN`.

### Entra, Graph, Dataverse, and Power Platform permissions

The current implementation uses a mix of application permissions, delegated user scopes, group-based access, and Dataverse application-user access.

#### Graph application permissions

The shared app registration needs these Microsoft Graph application permissions for inventory, revoke, and agent-control worker flows:

- `Directory.Read.All`
- `Files.Read.All`
- `Files.ReadWrite.All`
- `Group.Read.All`
- `Sites.Read.All`
- `User.Read.All`
- `Policy.ReadWrite.ConditionalAccess`
  Required for the worker's per-agent Conditional Access block/unblock flows.
- `Application.ReadWrite.All`
  Required for the worker's agent disable/enable flow that updates service principal `accountEnabled`.

#### Delegated user scopes

The baseline web sign-in flow requests only standard OIDC scopes plus refresh access:

- `openid`
- `profile`
- `email`
- `offline_access`
  Required so the web server can retain refresh capability for later delegated Graph and Power Platform calls.

Admin-only quarantine flows require additional delegated consent beyond baseline sign-in:

- `https://graph.microsoft.com/Directory.Read.All`
  Required for the signed-in admin role check against `me/transitiveMemberOf/microsoft.graph.directoryRole`.
- `https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke`
  Required for Copilot quarantine status reads and quarantine/unquarantine actions.

#### User access requirements

A signed-in user must satisfy all of these to use the new quarantine controls:

- membership in `ADMIN_GROUP_ID`
- one of these Entra admin roles:
  - `Global Administrator`
  - `AI Administrator`
  - `Power Platform Administrator`

#### Dataverse application-user access

The app-only Dataverse client uses the shared Entra app registration as a Dataverse application user. That application user needs table access in the target environment for:

- the existing table behind `DATAVERSE_TABLE_URL`
  Read/write access is required because the existing agent access-control flow still patches rows.
- the new `Agent Security-Group Mapping` table behind `DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL`
  Read access is required for the Copilot quarantine table at the top of `/dashboard/agents/agent-access-control`.

#### Power Platform prerequisites

For the quarantine feature to work in a tenant:

- the signed-in admin must successfully consent to `CopilotStudio.AdminActions.Invoke`
- the target bot must support the Copilot quarantine API
- the app must either be able to resolve the Power Platform environment from `DATAVERSE_BASE_URL`
  or be configured with `POWER_PLATFORM_ENVIRONMENT_ID`

### Optional integrations

- `DATAVERSE_BASE_URL`, `DATAVERSE_TABLE_URL`, and `DATAVERSE_COLUMN_PREFIX`
  Enable the web app's Dataverse-backed agent access helpers used by the agents pages and admin tooling.
- `POWER_PLATFORM_ENVIRONMENT_ID`
  Optional override for Copilot quarantine calls so the web app can skip Power Platform environment discovery.
- `DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL`
  Enables the Copilot quarantine table at the top of `/dashboard/agents/agent-access-control`.
- `APPINSIGHTS_APP_ID` and `APPINSIGHTS_API_KEY`
  Enable the `copilot_telemetry` worker job. The job is seeded by default but skips cleanly when Application Insights is not configured.
- `LICENSE_PUBLIC_KEY_PATH`
  Enables signed license verification outside the local Docker emulation path.
- `GRAPH_SYNC_TEST_MODE_GROUP_ID`
  Required only when the `test_mode` feature flag is enabled for scoped Graph sync.

## Jobs And Runtime Behavior

- The worker scheduler polls `job_schedules.next_run_at` every `SCHEDULER_POLL_SECONDS`.
- Scheduled and run-now execution use Postgres advisory locks so the same job does not run concurrently.
- Interrupted runs can be marked and recovered on startup when `RECOVER_INTERRUPTED_RUNS_ON_STARTUP=true`.
- The web app generates a fresh boot-scoped auth secret on every server boot, so web sessions are intentionally invalidated after web restarts and redeploys.
- The worker heartbeat posts to `/api/internal/worker-heartbeat` every `WORKER_HEARTBEAT_INTERVAL_SECONDS`; the health state is kept in memory and resets on worker restart.
- Graph sync behavior is controlled by environment variables such as `GRAPH_SYNC_PULL_PERMISSIONS`, `GRAPH_SYNC_GROUP_MEMBERSHIPS`, `GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY`, `GRAPH_SYNC_STAGES`, `GRAPH_SYNC_SKIP_STAGES`, `GRAPH_PERMISSIONS_BATCH_SIZE`, `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`, and `FLUSH_EVERY`.
- Materialized views are refreshed by the dedicated `mv_refresh` job, with dirty views queued in Postgres.

## Environment Configuration

Use [`.env.example`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.example) for local runtime configuration and [`.env.github.example`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.github.example) for staging workflow variables and secrets.

Common variables by area:

- auth and access:
  `NEXTAUTH_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ADMIN_GROUP_ID`, `USER_GROUP_ID`
  The web app generates its auth secret at startup instead of reading a long-lived configured value.
- database:
  `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `DB_CONNECT_TIMEOUT_SECONDS`
- internal service auth:
  `WORKER_API_URL`, `WORKER_INTERNAL_API_TOKEN`, `WORKER_HEARTBEAT_URL`, `WORKER_HEARTBEAT_TOKEN`
- licensing and feature state:
  `LICENSE_PUBLIC_KEY_PATH`, `LICENSE_CACHE_TTL_SECONDS`
- Graph ingestion:
  `GRAPH_BASE`, `GRAPH_MAX_CONCURRENCY`, `GRAPH_MAX_RETRIES`, `GRAPH_CONNECT_TIMEOUT`, `GRAPH_READ_TIMEOUT`, `GRAPH_PAGE_SIZE`, `GRAPH_PERMISSIONS_BATCH_SIZE`, `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`, `GRAPH_SYNC_*`
- worker/runtime tuning:
  `SCHEDULER_POLL_SECONDS`, `RECOVER_INTERRUPTED_RUNS_ON_STARTUP`, `FLUSH_EVERY`, `MV_REFRESH_MAX_VIEWS_PER_RUN`
- optional integrations:
  `DATAVERSE_BASE_URL`, `POWER_PLATFORM_ENVIRONMENT_ID`, `DATAVERSE_TABLE_URL`, `DATAVERSE_COLUMN_PREFIX`, `DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL`, `COPILOT_APP_ID`, `APPINSIGHTS_APP_ID`, `APPINSIGHTS_API_KEY`

## Developer Workflows

Web app:

```bash
cd web
npm ci
npm test
npm run build
```

Worker:

```bash
cd worker
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests
```

Database migration helper:

```bash
python3 scripts/db_migrations.py db/migrations/<migration_name>.sql
```

For staging deployment and Azure environment automation, start with [scripts/README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/README.md) and the runbook under [`scripts/New Deployment Scripts/DEPLOYMENT_RUNBOOK.md`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/New%20Deployment%20Scripts/DEPLOYMENT_RUNBOOK.md).
