# Web Component (`/web`)

The web component is the user and admin surface of Princeton Sentinel. It is a Next.js 16 App Router application that:

- handles Entra sign-in and group-based authorization
- serves the dashboard, site drill-down, admin, license, agents, and testing pages
- reads cached posture data from Postgres
- performs selected live Graph reads and permission revoke actions
- proxies privileged control-plane actions to the worker
- streams feature-state changes to connected clients

The web app does not run ingestion jobs itself.

## Runtime And Build

- framework: Next.js `16.2.3`
- React: `18.2.0`
- auth: `next-auth` with Azure AD provider
- DB driver: `pg`
- Graph auth client: `@azure/msal-node`
- Node requirement: `>=24`

Container/runtime files:

- Dockerfile: [web/Dockerfile](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/Dockerfile)
- Next config: [web/next.config.js](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/next.config.js)
- request proxy: [web/proxy.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/proxy.ts)

NPM scripts:

- `npm run dev`
- `npm run build`
- `npm run start`
- `npm test`

## Request Flow

At a high level:

1. The request enters the Next.js app through `web/proxy.ts`.
2. The proxy attaches security headers, CSP nonce state, request timing headers, and CSRF cookie state.
3. The proxy enforces auth rules based on session presence and Entra group claims.
4. Pages and API routes either:
   - query Postgres directly
   - call Microsoft Graph directly from the server
   - proxy internal operations to the worker with `WORKER_INTERNAL_API_TOKEN`

## Authentication And Authorization

Auth configuration lives in [web/app/lib/auth.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/auth.ts).

Current behavior:

- Entra credentials come from:
  - `ENTRA_TENANT_ID`
  - `ENTRA_CLIENT_ID`
  - `ENTRA_CLIENT_SECRET`
- authorization is group-based:
  - `ADMIN_GROUP_ID`
  - `USER_GROUP_ID`
- admin implies user access
- group claims are read from the ID token; group overage is not resolved through Graph

The request proxy currently protects:

- admin prefixes:
  - `/admin`
  - `/analytics`
  - `/jobs`
  - `/license`
  - `/runs`
  - `/api/license`
  - `/api/worker`
  - `/api/jobs`
  - `/api/schedules`
  - `/api/runs`
  - `/api/analytics`
  - `/api/agents/access-blocks`
- user prefixes:
  - `/dashboard`
  - `/sites`
  - `/testing`
  - `/api/graph`
  - `/api/feature-flags`
  - `/api/local-testing`

Public or special-case paths include:

- `/signin`
- `/signin/account`
- `/auth/complete`
- `/forbidden`
- `/403`
- `/api/auth/*`
- `/api/internal/worker-heartbeat`

## Current Page Surface

### User-facing pages

- `/`
  landing page that routes authenticated users into the app
- `/dashboard`
  overview metrics and charts
- `/dashboard/sites`
- `/dashboard/activity`
- `/dashboard/sharing`
- `/dashboard/sharing/links`
- `/dashboard/risk`
- `/dashboard/users`
- `/dashboard/users/[userId]`
- `/dashboard/groups`
- `/dashboard/groups/[groupId]`
- `/dashboard/items/[itemId]`
- `/sites/[driveId]`
- `/sites/[driveId]/files`
- `/sites/[driveId]/sharing`

### Agents pages

- `/dashboard/agents`
  Copilot telemetry dashboards and summaries
- `/dashboard/agents/dataverse`
  Dataverse-backed agent-user assignment view
- `/dashboard/agents/agent-access-control`
  Admin access-control actions over agent usage

These routes are gated by the `agents_dashboard` feature flag and the effective license state.

### Admin pages

- `/admin`
  worker overview and live control state
- `/admin/analytics`
- `/admin/revoke-activity`
- `/admin/agent-access-logs`
- `/admin/jobs`
- `/admin/runs`
- `/admin/runs/[jobType]`
- `/admin/runs/[jobType]/[runId]`
- `/license`

Top-level `/analytics`, `/jobs`, and `/runs` redirect to the admin routes.

### Local development/testing pages

- `/testing`
  local Docker-only page for license emulation

## Data Access Model

The web app mixes three access patterns:

### Cached Postgres reads

Most dashboards and admin pages read:

- materialized views for summary analytics
- `msgraph_*` tables for detail pages
- job tables for scheduler/admin state
- audit and revoke logs for operations pages
- Copilot telemetry tables for agents pages

### Live Microsoft Graph access

The server performs live Graph reads for:

- item sharing details
- item permission details
- permission revoke operations

Current route surface:

- `GET /api/graph/drive-item-sharing`
- `GET /api/graph/drive-item-permissions`
- `DELETE /api/graph/drive-item-permissions`

### Worker proxy access

The web app proxies internal operations to the worker for:

- health and job status
- run-now, pause, and resume
- Dataverse reads and writes used by agents tooling
- Conditional Access-backed agent disable/enable and user block/unblock flows

## API Surface

### Auth and session

- `GET|POST /api/auth/[...nextauth]`

### Dashboard/admin data APIs

- `GET /api/analytics`
- `GET /api/jobs`
- `POST /api/jobs`
  - supports `toggle`
  - returns `job_creation_disabled` for `create`
- `GET /api/schedules`
- `POST /api/schedules`
  - supports `create`, `toggle`, `update`, `delete`
- `GET /api/runs`
- `GET /api/runs/summary`

### Worker proxy APIs

- `GET /api/worker/status`
- `GET /api/worker/overview`
- `POST /api/worker/run-now`
- `POST /api/worker/pause`
- `POST /api/worker/resume`

These routes are admin-only and authenticate to the worker with `WORKER_INTERNAL_API_TOKEN`.

### License and feature-state APIs

- `GET|POST /api/license`
  - upload and activate a signed license artifact
  - clear the active license pointer for demo flows
- `GET /api/feature-flags`
- `GET /api/feature-flags/stream`
  - server-sent events backed by Postgres notifications
- `POST /api/local-testing/license`
  - local Docker-only toggle for emulated license state

### Agents and Dataverse APIs

- `GET /api/agents`
  summary data for the agents dashboard
- `GET|POST /api/agents/agent-access-control`
  direct Dataverse table read/write proxy
- `GET|POST /api/agents/dataverse`
  alias/export of the access-control route
- `GET|POST /api/agents/access-blocks`
  higher-level block/unblock, disable/enable, and register-agent operations

### Export APIs

- `GET /api/admin/revoke-logs/export`
- `GET /api/admin/agent-access-logs/export`

### Internal service API

- `POST /api/internal/worker-heartbeat`

This endpoint is intentionally exempt from normal user auth and validates `WORKER_HEARTBEAT_TOKEN`.

## Feature Flags And License Gating

Feature-flag logic lives under:

- [web/app/lib/feature-flags.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/feature-flags.ts)
- [web/app/lib/feature-flags-config.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/feature-flags-config.ts)
- [web/app/lib/feature-flags-stream.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/feature-flags-stream.ts)

Current flags:

- `agents_dashboard`
- `test_mode`

Important behavior:

- the effective `agents_dashboard` flag is the DB flag combined with the active license feature
- `/api/feature-flags/stream` subscribes to feature, license, and local testing changes
- local Docker license emulation participates in the same effective feature-state versioning path

License behavior lives in [web/app/lib/license.ts](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/license.ts). Admin job control, permission revoke, and agents features all depend on effective license state.

## Security Behavior

- auth enforcement is centralized in `web/proxy.ts` and reinforced by `requireUser()` and `requireAdmin()`
- CSRF validation is applied to state-changing POST/DELETE routes
- CSP, nonce headers, and no-cache headers are applied in the proxy layer
- Graph tokens are server-side only
- worker calls require `WORKER_INTERNAL_API_TOKEN`
- the heartbeat endpoint requires `WORKER_HEARTBEAT_TOKEN`

## Environment Variables

Common web-relevant variables:

- required:
  - `DATABASE_URL`
  - `NEXTAUTH_URL`
  - `NEXTAUTH_SECRET`
  - `ENTRA_TENANT_ID`
  - `ENTRA_CLIENT_ID`
  - `ENTRA_CLIENT_SECRET`
  - `ADMIN_GROUP_ID`
  - `USER_GROUP_ID`
  - `WORKER_API_URL`
  - `WORKER_INTERNAL_API_TOKEN`
  - `WORKER_HEARTBEAT_TOKEN`
- optional:
  - `CSRF_SECRET`
  - `INTERNAL_EMAIL_DOMAINS`
  - `DASHBOARD_DORMANT_LOOKBACK_DAYS`
  - `LICENSE_PUBLIC_KEY_PATH`
  - `LICENSE_CACHE_TTL_SECONDS`
  - `LOCAL_DOCKER_DEPLOYMENT`

See [../.env.example](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.example) for the current local template.

## Development Workflow

Install and run checks:

```bash
cd web
npm ci
npm test
npm run build
```

For local full-stack development, start the root Compose stack from the repository root:

```bash
docker compose up --build
```

## Operational Notes

- the web app is intentionally DB-heavy on the server side; many pages query handcrafted SQL directly from server components and routes
- `/admin` and some admin summaries poll for near-real-time state, while run-detail pages do not
- schedule management is intentionally one-schedule-per-job
- the agents area is now a first-class part of the web surface, not a sidecar tool
- `/testing` exists only for local Docker deployments and is hidden otherwise
