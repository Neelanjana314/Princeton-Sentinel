# Worker Component (`/worker`)

## Purpose
The worker is a Python service that combines:

- Internal Flask API for job control/status
- In-process scheduler loop (no external cron)
- Microsoft Graph ingestion pipeline (`graph_ingest`)
- Write path into Postgres (latest-state inventory + permission model)
- Heartbeat emitter to the web app

The worker is the system's ingestion engine and async execution plane.

---

## Runtime and Build

- Python `3.11`
- Flask `3.0.2`
- `psycopg2-binary` for DB access
- `msal` for Graph app-only token acquisition
- `requests` for HTTP
- `croniter` for schedule calculation

Container runtime:

- Dockerfile: `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/Dockerfile`
- Exposed port: `5000`
- Startup command: `python -m app.main`

Startup side effects from `app.main`:

1. Create Flask app
2. Start scheduler daemon thread
3. Start heartbeat daemon thread

---

## Internal API (`app/api.py`)

### `GET /health`

Returns:

- DB connectivity status (`SELECT 1`)
- scheduler status (`running`, `last_tick`, `last_error`)
- heartbeat status (attempt/success/failure counters)
- top-level `ok = db_ok && heartbeat_healthy`

### `GET /jobs/status`

Joins:

- `jobs`
- `job_schedules`
- `mv_latest_job_runs`

Provides consolidated admin/control-plane status.

### `POST /jobs/run-now`

- Requires `job_id` in body
- Looks up job
- Logs `job_run_requested` audit event
- Spawns background thread that calls `run_job_once(job, actor)`
- Returns `202 queued`

### `POST /jobs/pause` and `POST /jobs/resume`

- `pause` updates `job_schedules.enabled=false` and clears `job_schedules.next_run_at`
- `resume` updates `job_schedules.enabled=true`, clears `job_schedules.next_run_at`, and restores `jobs.enabled=true`
- Writes audit events (`job_paused` / `job_resumed`)

### Auth note

An auth helper module exists (`app/auth.py`) but control endpoints are currently designed for internal use and are invoked via the web app proxy layer.

---

## Scheduler Engine (`app/scheduler.py`)

## Poll loop

- Interval: `SCHEDULER_POLL_SECONDS` (default 30)
- Each tick:
  1. initialize one schedule with `next_run_at IS NULL` (if present)
  2. otherwise pick one due schedule (`next_run_at <= now()`)

Uses `FOR UPDATE SKIP LOCKED` to avoid concurrent contention.

## Locking model

- Job-level mutual exclusion via Postgres advisory locks:
  - `pg_try_advisory_lock(hashtext(job_id))`
- If lock unavailable:
  - run is skipped/logged
  - scheduler continues

## Run lifecycle

For scheduled and run-now execution:

1. Insert `job_runs` row with `status='running'`
2. Execute job implementation by `job_type`
3. Update `job_runs.finished_at/status/error`
4. Release advisory lock
5. Write audit events and `job_run_logs`

Supported job types:

- `graph_ingest` only

Unknown job types raise runtime error and mark run as failed.

---

## Heartbeat Thread (`app/heartbeat.py`)

Worker periodically POSTs to:

- `WORKER_HEARTBEAT_URL` (default `http://web:3000/api/internal/worker-heartbeat`)

Config:

- `WORKER_HEARTBEAT_INTERVAL_SECONDS` (default 30)
- `WORKER_HEARTBEAT_TIMEOUT_SECONDS` (default 5)
- `WORKER_HEARTBEAT_FAIL_THRESHOLD` (default 2)

State tracked in-memory:

- last attempt time
- last success time
- consecutive failures
- last error

Health degrades when consecutive failures reach threshold.

---

## Graph Client (`app/graph_client.py`)

## Token acquisition

- App-only token via MSAL confidential client
- Scope: `https://graph.microsoft.com/.default`
- Cached token with refresh margin

## Request behavior

- Base URL default: `https://graph.microsoft.com/v1.0`
- Retries transport and transient HTTP statuses:
  - `408`, `429`, `500`, `502`, `503`, `504`
- Handles `401` by clearing token cache and retrying
- Supports `Retry-After`
- Exponential backoff with jitter

## Pagination helpers

- `iter_paged(...)` follows `@odata.nextLink`
- `collect_paged(...)` materializes full list

---

## Ingestion Pipeline (`app/jobs/graph_ingest.py`)

`run_graph_ingest(run_id, job_id, actor)` executes stage pipeline.

Default stage order:

1. `users`
2. `groups`
3. `group_memberships`
4. `sites`
5. `drives`
6. `drive_items`
7. `permissions`

Runtime controls (env-only):

- `FLUSH_EVERY`
- `GRAPH_SYNC_PULL_PERMISSIONS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY`
- `GRAPH_PERMISSIONS_BATCH_SIZE`
- `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`
- `GRAPH_SYNC_STAGES` (comma-separated subset order)
- `GRAPH_SYNC_SKIP_STAGES` (comma-separated exclusions)

## Stage details

### Users

- Graph: `/users`
- Upsert `msgraph_users`
- Soft-delete rows not seen in current sync (`deleted_at`)

### Groups

- Graph: `/groups`
- Upsert `msgraph_groups`
- Soft-delete stale rows

### Group memberships

- For each active group, call `/groups/{id}/members`
- Upsert `msgraph_group_memberships`
- Optional filter to `user` members only
- Per-group soft-delete of stale edges
- Non-fatal skip on common Graph errors

### Sites

- Preferred: `/sites/delta`
- Fallback: `/sites?search=*` on delta failure
- Upserts active rows in `msgraph_sites`
- Marks removed sites using `@removed`
- Stores delta cursor in `msgraph_delta_state` (`resource_type='sites'`)

### Drives

Sources:

- site drives (`/sites/{id}/drives`)
- group drives (`/groups/{id}/drives`)
- user drives (`/users/{id}/drives`)

Writes:

- Upsert `msgraph_drives`
- Identity normalization for owner/createdBy/lastModifiedBy
- Dedupe and merge rows by drive id before write

### Drive items

- Per drive: `/drives/{drive_id}/root/delta`
- Stores active/removed item states in `msgraph_drive_items`
- Handles delta expiration (`410`) by resetting drive cursor and retrying
- For removed items, also deletes related rows from:
  - `msgraph_drive_item_permission_grants`
  - `msgraph_drive_item_permissions`
- Advances delta cursor only if cleanup writes succeed

### Permissions

- Selects non-folder items from `msgraph_drive_items` when any of these are true:
  - stale (`permissions_last_synced_at` older than cutoff)
  - previously errored (`permissions_last_error_at` is set)
  - recently updated (`modified_dt` within cutoff window)
- Prioritizes errored items before oldest-sync items
- Concurrently fetches `/drives/{drive}/items/{item}/permissions`
- Rebuilds permission state per item:
  - delete existing grants/permissions for successful keys
  - insert fresh `msgraph_drive_item_permissions`
  - insert fresh `msgraph_drive_item_permission_grants`
- Updates item sync/error fields:
  - `permissions_last_synced_at`
  - `permissions_last_error_at`
  - `permissions_last_error`
  - `permissions_last_error_details` (structured diagnostics:
    category/status/code/message/request URL/response excerpt/run phase/attempt)
- For `404` permission fetch errors, clears cached permission/grant rows for the item and records structured diagnostics
- Runs one end-of-stage retry pass for keys that failed earlier in the same run
- Contains terminal failure handling:
  - retry DB writes
  - mark batch error if writes exhaust retries
  - temporarily defer problematic keys
  - drop keys after repeated terminal failures in same run

---

## DB Write Resilience

Shared DB retry utilities (`app/db.py` + helpers in ingest):

- Retryable SQLSTATEs:
  - `40P01` deadlock
  - `55P03` lock_not_available
  - `40001` serialization_failure
- Exponential backoff + jitter controlled by env vars:
  - `DB_WRITE_MAX_RETRIES`
  - `DB_WRITE_RETRY_BASE_MS`
  - `DB_WRITE_RETRY_MAX_MS`
  - `DB_WRITE_RETRY_JITTER_MS`

Non-retryable errors fail fast.

---

## Logging and Audit

Runtime logs:

- `emit(level, actor, message)` with constrained actor/type sets
- Actors include: `FLASK_API`, `SCHEDULER`, `HEARTBEAT`, `GRAPH`, `DB_CONN`

Persistent logs/audit:

- `audit_events` for control and job lifecycle actions
- `job_run_logs` for per-run structured context messages

---

## Integration with Web

Web invokes worker through `WORKER_API_URL`:

- status
- run-now
- pause
- resume

For run-now/pause/resume web forwards actor claims; worker writes these to `audit_events`.

Worker heartbeat depends on web internal endpoint availability for healthy status.

---

## Integration with Database

Worker is primary writer for:

- `msgraph_users`
- `msgraph_groups`
- `msgraph_group_memberships`
- `msgraph_sites`
- `msgraph_drives`
- `msgraph_drive_items`
- `msgraph_drive_item_permissions`
- `msgraph_drive_item_permission_grants`
- `msgraph_delta_state`
- `job_runs`
- `job_run_logs`
- `audit_events`

DB trigger layer refreshes materialized views on base table writes (configured in DB init SQL).

---

## Environment Variables (Worker-relevant)

Required:

- `DATABASE_URL`
- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- `ENTRA_CLIENT_SECRET`

Scheduler:

- `SCHEDULER_POLL_SECONDS`
- `RECOVER_INTERRUPTED_RUNS_ON_STARTUP`

Heartbeat:

- `WORKER_HEARTBEAT_URL`
- `WORKER_HEARTBEAT_INTERVAL_SECONDS`
- `WORKER_HEARTBEAT_TIMEOUT_SECONDS`
- `WORKER_HEARTBEAT_FAIL_THRESHOLD`

Graph client:

- `GRAPH_BASE`
- `GRAPH_MAX_RETRIES`
- `GRAPH_CONNECT_TIMEOUT`
- `GRAPH_READ_TIMEOUT`
- `GRAPH_PAGE_SIZE`
- `GRAPH_MAX_CONCURRENCY`

Permissions scan:

- `GRAPH_PERMISSIONS_BATCH_SIZE`
- `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`

Batching/retry:

- `FLUSH_EVERY`
- `GRAPH_SYNC_PULL_PERMISSIONS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY`
- `GRAPH_SYNC_STAGES`
- `GRAPH_SYNC_SKIP_STAGES`
- `DB_CONNECT_TIMEOUT_SECONDS`
- `DB_WRITE_MAX_RETRIES`
- `DB_WRITE_RETRY_BASE_MS`
- `DB_WRITE_RETRY_MAX_MS`
- `DB_WRITE_RETRY_JITTER_MS`

---

## Operational Caveats

- Scheduler and API run in same process; very heavy ingest can impact API responsiveness.
- Status may report worker degraded if heartbeat to web fails, even when DB/Graph ingestion remains possible.
- Materialized view refresh load is triggered by DB triggers, not directly controlled in worker code.
- `jobs.config` is not used for `graph_ingest`; runtime behavior is controlled by environment variables.
- Job types are hardcoded; adding new jobs requires scheduler dispatch changes plus schema/API updates.
- On startup, worker can auto-mark orphaned `running` rows as failed (`interrupted_worker_restart`) when `RECOVER_INTERRUPTED_RUNS_ON_STARTUP=true`.
- Interrupted-run recovery commits DB updates before emitting recovered-count logs.
- Recovery audit/log emission is best-effort; logging failures do not roll back recovered run state.
