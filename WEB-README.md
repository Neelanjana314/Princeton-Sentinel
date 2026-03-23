# Web Component (`/web`)

## Purpose
The web component is a Next.js application that serves:

- Interactive dashboard UI
- Server-side data access to Postgres (cached posture analytics + detailed tables)
- AuthN/AuthZ and route protection
- Admin control-plane APIs that proxy to the worker
- Live Graph drill-down APIs for item-level verification and permission revoke

The web app does **not** run ingestion jobs directly. It orchestrates intent (run-now, pause/resume, schedule changes) and reads from DB.

---

## Runtime and Build

- Framework: Next.js `16.1.7`
- React: `18.2.0`
- Auth: `next-auth` + Azure AD provider
- DB driver: `pg`
- Graph auth client: `@azure/msal-node`

Container runtime:

- Dockerfile: `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/Dockerfile`
- Exposed port: `3000`
- Startup: `npm start`

NPM scripts:

- `npm run dev` -> Next dev server on port `3000`
- `npm run build` -> production build
- `npm run start` -> production server

---

## High-Level Architecture

1. Browser hits App Router pages.
2. Middleware checks JWT/group claims and path-level policy.
3. Server components query Postgres directly for cached data (materialized views + base tables).
4. Admin actions call web API routes:
   - some write directly to DB (`/api/jobs`, `/api/schedules`)
   - some proxy to worker (`/api/worker/*`, including `/api/worker/overview`)
5. Item drill-down uses live Graph API in addition to cached DB records.

---

## Authentication and Authorization

### Authentication path

- Implemented in `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/auth.ts`
- `next-auth` Azure AD provider configured with:
  - `ENTRA_TENANT_ID`
  - `ENTRA_CLIENT_ID`
  - `ENTRA_CLIENT_SECRET`
- JWT callback stores:
  - `groups`
  - `oid`
  - `upn`
  - `accessToken` (if present)

### Group-based authorization

- Admin group from `ADMIN_GROUP_ID`
- User group from `USER_GROUP_ID`
- Admin implies user access
- Middleware hard-gates route prefixes:
  - Admin prefixes: `/admin`, `/analytics`, `/jobs`, `/runs`, `/api/worker`, `/api/jobs`, `/api/schedules`, `/api/runs`, `/api/analytics`
  - User prefixes: `/dashboard`, `/sites`, `/api/graph`

### Important auth behavior

- If no token:
  - API -> `401`
  - pages -> redirect to `/signin/account?callbackUrl=...`
- If token exists but group check fails:
  - API -> `403`
  - pages -> redirect `/forbidden`
- `/api/internal/worker-heartbeat` is intentionally exempt from middleware auth and instead validates `WORKER_HEARTBEAT_TOKEN`.

---

## Data Access Model

### Cached DB mode (default UI mode)

Most dashboard pages read from:

- Materialized views (`mv_*`) for summary/aggregates
- Base tables (`msgraph_*`) for detail pages and ranked item lists

### Live Graph mode (verification and control)

Used in specific paths:

- `/dashboard/items/[itemId]` fetches live item + live permissions from Graph
- `/api/graph/drive-item-permissions` GET/DELETE
- `/api/graph/drive-item-sharing` GET

This dual model keeps dashboards fast while still enabling on-demand source-of-truth checks.

---

## Web API Surface

### Admin and operations APIs

- `GET /api/analytics`
  - Reads `mv_msgraph_inventory_summary`, `mv_msgraph_sharing_posture_summary`, `mv_refresh_log`
  - Admin only

- `GET /api/jobs`
  - Lists jobs from `jobs`
  - Admin only

- `POST /api/jobs`
  - `action=create` is disabled (`403`)
  - Admin UI no longer allows creating jobs or editing per-job config.
  - Admin only

- `GET /api/schedules`
  - Lists `job_schedules`
  - Admin only

- `POST /api/schedules`
  - `action=create`: inserts schedule row; returns `409` if schedule already exists for job
  - `action=toggle`: updates `job_schedules.enabled` and clears `next_run_at`
  - Writes audit event
  - Admin only

- `GET /api/runs`
  - Reads `job_runs` + latest `job_run_logs` entry per run
  - Admin only

- `GET /api/runs/summary`
  - Reads only the latest run per `job_type` + latest `job_run_logs` entry
  - Used by `/admin/runs` for live summary refresh
  - Admin only

### Worker proxy APIs

- `GET /api/worker/status` -> proxies `GET {WORKER_API_URL}/jobs/status`
- `GET /api/worker/overview` -> fetches `GET {WORKER_API_URL}/health` + `GET {WORKER_API_URL}/jobs/status`
- `POST /api/worker/run-now` -> posts `job_id` + actor identity to worker
- `POST /api/worker/pause` -> posts `job_id` + actor identity to worker
- `POST /api/worker/resume` -> posts `job_id` + actor identity to worker

All admin-only. The web layer is the policy gate; worker endpoints are internal and authenticated with `WORKER_INTERNAL_API_TOKEN`.

### Graph APIs

- `GET /api/graph/drive-item-sharing?driveId=&itemId=`
  - Requires user
  - Calls Graph `GET /drives/{drive}/items/{item}`

- `GET /api/graph/drive-item-permissions?driveId=&itemId=`
  - Requires user
  - Calls Graph permissions endpoint

- `DELETE /api/graph/drive-item-permissions`
  - Requires admin
  - Validates permission is not inherited and not owner role
  - Deletes permission in Graph
  - Deletes cached permission rows in DB via transaction:
    - `msgraph_drive_item_permission_grants`
    - `msgraph_drive_item_permissions`
    - updates `msgraph_drive_items.permissions_last_synced_at`
  - Writes `audit_events` and `revoke_permission_logs`
  - Returns warning payload if Graph succeeded but local sync/audit had issues

### Internal heartbeat API

- `POST /api/internal/worker-heartbeat`
  - Liveness endpoint for worker heartbeat thread
  - Authenticated with `X-Worker-Heartbeat-Token` / `WORKER_HEARTBEAT_TOKEN`
  - Returns `{ ok: true, received_at: ... }`

---

## UI Route Topology

### Main app shells

- `DashboardLayout` and `SitesLayout` enforce signed-in + user-group access.
- `AdminLayout` enforces admin-group access and renders admin tabs.
- `AppShell` renders global navigation and user menu.

### Major dashboard routes

- `/dashboard`
  - Summary cards/charts using MV-backed queries
- `/dashboard/sites`
  - Uses routable site-drive CTE to unify SharePoint sites + personal drives
- `/dashboard/activity`
  - Activity over window (`days`), including modified items and link-share counts
- `/dashboard/sharing`
  - Link breakdown + per-site sharing summary + external principal counts
- `/dashboard/risk`
  - Heuristic risk flags (dormancy, anonymous/org links, external principals)
- `/dashboard/users`, `/dashboard/users/[userId]`
  - User activity derived from `last_modified_by_user_id`
- `/dashboard/groups`, `/dashboard/groups/[groupId]`
  - Group inventory + membership details
- `/dashboard/items/[itemId]`
  - Cached + live item/permission merge; supports revoke actions for admins

### Site/drive detail routes

- `/sites/[driveId]` overview
- `/sites/[driveId]/files`
- `/sites/[driveId]/sharing`

These routes read base tables (`msgraph_drives`, `msgraph_drive_items`, `msgraph_drive_item_permissions`, grants) for drive-centric investigations.

---

## Integration with Worker

### Contract

The web component expects worker endpoints:

- `GET /health`
- `GET /jobs/status`
- `POST /jobs/run-now`
- `POST /jobs/pause`
- `POST /jobs/resume`

via `WORKER_API_URL`.

### Identity propagation

When web triggers worker actions, it forwards actor metadata in body:

- `oid`
- `upn`
- `name`

Worker uses this to write audit/job-run logs.

---

## Integration with Database

### DB client utilities

- `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/web/app/lib/db.ts`
  - global pooled `pg.Pool`
  - `query(...)`
  - `withTransaction(...)`

### Read patterns

- Summary views: `mv_msgraph_*`
- Detail and drill-down: `msgraph_*` base tables
- Admin operational tables: `jobs`, `job_schedules`, `job_runs`, `job_run_logs`
- Audit/logging tables: `audit_events`, `revoke_permission_logs`

### Write patterns

- Admin CRUD-like actions for jobs/schedules
- Revoke path local cache cleanup
- Audit and revoke-log inserts

---

## Environment Variables (Web-relevant)

Required:

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

Optional/tuning:

- `INTERNAL_EMAIL_DOMAINS`
- `DASHBOARD_DORMANT_LOOKBACK_DAYS`

---

## Operational Notes

- Route authorization is centralized in middleware and reinforced in server helpers (`requireUser`, `requireAdmin`).
- The app intentionally mixes cached DB intelligence with selective live Graph checks.
- Worker heartbeat endpoint is intentionally lightweight and authenticated with a shared heartbeat token.
- Revoke flow is best-effort audited; failures in auxiliary logging are surfaced as warnings, not hard failures after Graph delete succeeds.
- Admin control pages (`/admin`, `/admin/analytics`, `/admin/runs`) use live polling every 5 seconds for near-real-time state.
- `/admin/runs` shows latest run per job type; clicking a type opens `/admin/runs/[jobType]` for paginated history, and clicking a run opens `/admin/runs/[jobType]/[runId]` for full run logs (no live polling on detail pages).
- Job scheduling is one-schedule-per-job by design; create attempts for already scheduled jobs are rejected.

---

## Known Constraints

- Group overage in Entra tokens (`_claim_names.groups`) is not resolved via Graph and can block access.
- Many page queries are handcrafted SQL in server components; schema changes require coordinated updates.
- Live Graph fetches on detail pages can fail independently of cached DB rendering.
