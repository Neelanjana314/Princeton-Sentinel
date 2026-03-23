# Princeton Sentinel

Princeton Sentinel is a Docker Compose-driven data posture dashboard for Microsoft 365. It keeps heavy Graph ingestion in a worker, stores latest-state inventory in Postgres, and serves a Next.js UI with cached dashboards plus live Graph drill-downs.

## Stack

- **postgres (16)**: system of record, scheduling metadata, typed Graph tables, materialized views
- **web (Next.js)**: UI + API routes, declares schedules/intents, never runs jobs
- **worker (Python/Flask)**: scheduler loop (no cron), Graph ingestion, MV refresh

## Quick start

1. Copy `.env.example` to `.env` and fill in the Entra + DB values.
2. Build and run:

```
docker compose up --build
```

3. Visit `http://localhost:3000`.

## Entra configuration notes

- Single Entra app registration is used for both web and worker.
- **Group-based access control** uses the `groups` claim in the token (configure the claim for **ID tokens**). The app **does not** call Graph for group overage resolution.
  - Ensure the `groups` claim is configured for ID tokens (Token configuration in Entra).
  - If your tenant has group overage, the claim will be replaced by `_claim_names` and access will be denied.
- The worker API is internal-only and protected by `WORKER_INTERNAL_API_TOKEN`; the web app passes the actor identity (oid/upn/name) in the request body for audit logging.

### Admin-consented Graph application permissions

The worker + web Graph calls expect the following permissions (as provided):

- AuditActivity.Read
- AuditLog.Read.All
- Directory.Read.All
- Directory.ReadWrite.All
- Files.Read.All
- Files.ReadWrite.All
- Group.Read.All
- Reports.Read.All
- SensitivityLabels.Read.All
- Sites.Read.All
- Sites.ReadWrite.All
- User.Read.All

## Scheduling

- No default schedule is created. Create schedules from the **Jobs** page after first boot.
- Scheduler uses **Postgres advisory locks** and polls `job_schedules.next_run_at` every `SCHEDULER_POLL_SECONDS`.
- Worker sends a heartbeat to web every `WORKER_HEARTBEAT_INTERVAL_SECONDS` (default 30s); heartbeat state is in-memory and resets on worker restart.

## Key URLs

- `/analytics` -- cached dashboard summaries (materialized views)
- `/jobs` -- job + schedule management
- `/runs` -- job run history
- `/license` -- active license artifact + upload (admin group only)
- `/admin` -- worker status and run-now controls (admin group only)

## Environment variables

See `.env.example` for the full list. Key values:

- `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`
- `ADMIN_GROUP_ID`, `USER_GROUP_ID`
- `DATABASE_URL`
- `LICENSE_PUBLIC_KEY_PATH`, `LICENSE_CACHE_TTL_SECONDS`
- `WORKER_API_URL`, `WORKER_INTERNAL_API_TOKEN`, `WORKER_HEARTBEAT_TOKEN`
- `DB_WRITE_MAX_RETRIES`, `DB_WRITE_RETRY_BASE_MS`, `DB_WRITE_RETRY_MAX_MS`, `DB_WRITE_RETRY_JITTER_MS`
- `GRAPH_MAX_CONCURRENCY`, `GRAPH_MAX_RETRIES`, `GRAPH_CONNECT_TIMEOUT`, `GRAPH_READ_TIMEOUT`
- `GRAPH_PAGE_SIZE`, `GRAPH_PERMISSIONS_BATCH_SIZE`, `GRAPH_PERMISSIONS_STALE_AFTER_HOURS`
- `FLUSH_EVERY`
- `WORKER_HEARTBEAT_URL`, `WORKER_HEARTBEAT_INTERVAL_SECONDS`, `WORKER_HEARTBEAT_TIMEOUT_SECONDS`, `WORKER_HEARTBEAT_FAIL_THRESHOLD`

## Notes

- Graph tokens are **server-side only**.
- Inventory tables store **latest state only** with **soft deletes** (`deleted_at`).
- Materialized views support `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- Permission scans run a **full pass** until no stale items remain; use `GRAPH_PERMISSIONS_STALE_AFTER_HOURS` to control re-scan cadence.
- Permission and drive-item permission-cleanup writes use retryable DB backoff to tolerate transient lock contention.
- The worker writes per-run logs into Postgres (`job_run_logs`) keyed by `run_id`.
- `graph_ingest` supports optional job config keys: `stages` / `skip_stages` for running a subset of the pipeline.
