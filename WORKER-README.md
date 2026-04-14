# Worker Component (`/worker`)

The worker is the execution plane of Princeton Sentinel. It is a Python 3.11 service that combines:

- an internal Flask API
- an in-process scheduler
- Microsoft Graph ingestion
- materialized-view refresh execution
- Copilot telemetry ingestion from Application Insights
- Dataverse proxy helpers for the agents area
- Conditional Access-backed control actions
- heartbeat reporting back to the web app

## Runtime And Build

- Python `3.11`
- Flask `3.1.3`
- Gunicorn `22.0.0`
- `psycopg2-binary`
- `requests`
- `msal`
- `croniter`
- `PyJWT`
- `cryptography`

Container/runtime files:

- Dockerfile: [worker/Dockerfile](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/Dockerfile)
- entry module: [worker/app/main.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/main.py)

Container startup command:

```bash
python -m gunicorn --bind 0.0.0.0:5000 --workers 1 --threads 4 app.main:app
```

## Boot Flow

`app.main`:

1. creates the Flask app
2. starts the scheduler thread
3. starts the heartbeat thread

Background threads can be disabled with `WORKER_ENABLE_BACKGROUND_THREADS=false`, which is used by some packaging/test workflows.

## Internal API

The Flask routes live in [worker/app/api.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/api.py). All endpoints require `X-Worker-Internal-Token` unless noted otherwise.

### Health and job control

- `GET /health`
  - DB connectivity
  - scheduler status
  - heartbeat status
  - effective license summary
- `GET /jobs/status`
  - current jobs, schedules, latest run state, and effective license summary
- `POST /jobs/run-now`
- `POST /jobs/pause`
- `POST /jobs/resume`

Job-control endpoints are license-gated. `run-now` also checks the job-type-specific license feature where applicable.

### Conditional Access and agent control

- `POST /conditional-access/block`
- `POST /conditional-access/unblock`
- `POST /conditional-access/disable-agent`
- `POST /conditional-access/enable-agent`

These endpoints support the admin agent access workflows exposed through the web app.

### Dataverse proxy helpers

- `GET /dataverse/table`
- `POST /dataverse/patch`

The web app uses these routes to query and patch Dataverse-backed agent access data without exposing Dataverse credentials to the browser.

## Scheduler

The scheduler implementation lives in [worker/app/scheduler.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/scheduler.py).

Current behavior:

- poll interval comes from `SCHEDULER_POLL_SECONDS`
- the loop first initializes one schedule with `next_run_at IS NULL`
- otherwise it selects one due schedule with `FOR UPDATE SKIP LOCKED`
- execution uses Postgres advisory locks keyed by job id so the same job does not run concurrently
- interrupted `running` rows can be recovered on startup when `RECOVER_INTERRUPTED_RUNS_ON_STARTUP=true`

Supported job types:

- `graph_ingest`
- `mv_refresh`
- `copilot_telemetry`

License mapping:

- `graph_ingest` requires the `graph_ingest` feature
- `copilot_telemetry` requires the `copilot_telemetry` feature
- admin-triggered control actions require `job_control`

## Graph Ingestion

The Graph pipeline lives in [worker/app/jobs/graph_ingest.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/jobs/graph_ingest.py).

Default stage order:

1. `users`
2. `groups`
3. `group_memberships`
4. `sites`
5. `drives`
6. `drive_items`
7. `permissions`

Runtime controls:

- `FLUSH_EVERY`
- `GRAPH_SYNC_PULL_PERMISSIONS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS`
- `GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY`
- `GRAPH_SYNC_STAGES`
- `GRAPH_SYNC_SKIP_STAGES`
- `GRAPH_PERMISSIONS_BATCH_SIZE`
- `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`

Important behavior:

- users, groups, sites, drives, and items are stored as latest-state rows with soft deletes
- `sites` uses delta where possible and falls back when needed
- `drive_items` uses per-drive delta cursors
- `permissions` uses targeted stale/error/recently-modified selection instead of full-tenant permission reload on every run
- 404 permission fetches clear cached permission rows for the item and record structured diagnostics
- the job queues impacted MVs after writes

### Test mode

Graph sync test mode is controlled jointly by:

- DB feature flag `test_mode`
- environment variable `GRAPH_SYNC_TEST_MODE_GROUP_ID`
- persisted DB state in `graph_sync_mode_state`

When enabled, the worker scopes Graph sync to the configured test group and can prune data outside that scope.

## Materialized View Refresh Job

`mv_refresh` lives in [worker/app/jobs/mv_refresh.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/jobs/mv_refresh.py).

It:

- reads queued view names from `mv_refresh_queue`
- refreshes them with `REFRESH MATERIALIZED VIEW CONCURRENTLY`
- records success timestamps in `mv_refresh_log`
- deletes successfully refreshed queue entries

Runtime tuning:

- `MV_REFRESH_MAX_VIEWS_PER_RUN`

## Copilot Telemetry Job

`copilot_telemetry` lives in [worker/app/jobs/copilot_telemetry.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/jobs/copilot_telemetry.py).

It reads Copilot Studio telemetry from Application Insights and writes:

- `copilot_sessions`
- `copilot_events`
- `copilot_errors`
- `copilot_topic_stats`
- `copilot_tool_stats`
- `copilot_response_times`
- `copilot_topic_stats_hourly`
- `copilot_tool_stats_hourly`

Important behavior:

- the job is seeded by default but skips cleanly when `APPINSIGHTS_APP_ID` or `APPINSIGHTS_API_KEY` is missing
- `lookback_hours` comes from the job config row
- session writes can enqueue `mv_copilot_summary` refresh work

## Heartbeat

Heartbeat logic lives in [worker/app/heartbeat.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/heartbeat.py).

The worker periodically POSTs to the web endpoint configured by `WORKER_HEARTBEAT_URL`, normally:

`http://web:3000/api/internal/worker-heartbeat`

Controls:

- `WORKER_HEARTBEAT_INTERVAL_SECONDS`
- `WORKER_HEARTBEAT_TIMEOUT_SECONDS`
- `WORKER_HEARTBEAT_FAIL_THRESHOLD`
- `WORKER_HEARTBEAT_TOKEN`

Health degrades when failures cross the configured threshold.

## Graph And Dataverse Clients

### Graph client

[worker/app/graph_client.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/graph_client.py) handles:

- app-only MSAL token acquisition with `https://graph.microsoft.com/.default`
- retry/backoff for transient HTTP failures
- `Retry-After` handling
- pagination helpers for `@odata.nextLink`

### Dataverse client

[worker/app/dataverse_client.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/dataverse_client.py) handles:

- client-credentials auth against `DATAVERSE_URL`
- paged Dataverse table reads
- single-row patch operations

It is used by the worker API, not directly by browser clients.

## Licensing Behavior

License logic lives in [worker/app/license.py](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/worker/app/license.py).

Current behavior:

- verifies signed artifacts from `license_artifacts` using `LICENSE_PUBLIC_KEY_PATH`
- exposes a cached effective license summary
- gates job-control and job-type-specific actions
- supports local Docker emulation through `local_testing_state`

In local Docker:

- if `LOCAL_DOCKER_DEPLOYMENT=true` and local testing emulation is enabled, the worker reports a synthetic full-feature license
- if emulation is disabled, the worker reports the missing-license fallback and write features stay read-only

## Logging And Audit

Worker logging has two layers:

- runtime logs emitted through `emit(...)`
- persistent DB records in:
  - `audit_events`
  - `job_run_logs`

Run logs are structured and keyed by `run_id`, which is what the web run detail pages display.

## Database Writes

The worker is the primary writer for:

- `msgraph_*`
- `msgraph_delta_state`
- `job_runs`
- `job_run_logs`
- `audit_events`
- Copilot telemetry tables
- agent-control support tables touched by worker-side actions

DB write retries are applied for transient lock/contention errors using:

- `DB_WRITE_MAX_RETRIES`
- `DB_WRITE_RETRY_BASE_MS`
- `DB_WRITE_RETRY_MAX_MS`
- `DB_WRITE_RETRY_JITTER_MS`

## Environment Variables

Common worker-relevant variables:

- required:
  - `DATABASE_URL`
  - `ENTRA_TENANT_ID`
  - `ENTRA_CLIENT_ID`
  - `ENTRA_CLIENT_SECRET`
  - `WORKER_INTERNAL_API_TOKEN`
  - `WORKER_HEARTBEAT_TOKEN`
- scheduler/runtime:
  - `SCHEDULER_POLL_SECONDS`
  - `RECOVER_INTERRUPTED_RUNS_ON_STARTUP`
  - `WORKER_ENABLE_BACKGROUND_THREADS`
  - `LOCAL_DOCKER_DEPLOYMENT`
- heartbeat:
  - `WORKER_HEARTBEAT_URL`
  - `WORKER_HEARTBEAT_INTERVAL_SECONDS`
  - `WORKER_HEARTBEAT_TIMEOUT_SECONDS`
  - `WORKER_HEARTBEAT_FAIL_THRESHOLD`
- Graph:
  - `GRAPH_BASE`
  - `GRAPH_MAX_CONCURRENCY`
  - `GRAPH_MAX_RETRIES`
  - `GRAPH_CONNECT_TIMEOUT`
  - `GRAPH_READ_TIMEOUT`
  - `GRAPH_PAGE_SIZE`
  - `GRAPH_PERMISSIONS_BATCH_SIZE`
  - `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`
  - `GRAPH_SYNC_PULL_PERMISSIONS`
  - `GRAPH_SYNC_GROUP_MEMBERSHIPS`
  - `GRAPH_SYNC_GROUP_MEMBERSHIPS_USERS_ONLY`
  - `GRAPH_SYNC_STAGES`
  - `GRAPH_SYNC_SKIP_STAGES`
  - `GRAPH_SYNC_TEST_MODE_GROUP_ID`
- refresh/write tuning:
  - `FLUSH_EVERY`
  - `MV_REFRESH_MAX_VIEWS_PER_RUN`
  - `DB_CONNECT_TIMEOUT_SECONDS`
  - `DB_WRITE_MAX_RETRIES`
  - `DB_WRITE_RETRY_BASE_MS`
  - `DB_WRITE_RETRY_MAX_MS`
  - `DB_WRITE_RETRY_JITTER_MS`
- optional integrations:
  - `DATAVERSE_URL`
  - `APPINSIGHTS_APP_ID`
  - `APPINSIGHTS_API_KEY`
  - `LICENSE_PUBLIC_KEY_PATH`
  - `LICENSE_CACHE_TTL_SECONDS`

See [../.env.example](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/.env.example) for the current template.

## Development Workflow

Install dependencies and run tests:

```bash
cd worker
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests
```

For full local integration, run the repository Compose stack from the repo root:

```bash
docker compose up --build
```

## Operational Notes

- the worker is intentionally stateful in-memory for scheduler and heartbeat status, so those counters reset on restart
- Dataverse and Conditional Access functionality are optional integrations; the internal API returns classified errors when they are not configured correctly
- `copilot_telemetry` is a supported job type now and should be treated like the other worker jobs in operational docs and tooling
- the worker is the authoritative writer for most runtime state transitions visible in the admin UI
