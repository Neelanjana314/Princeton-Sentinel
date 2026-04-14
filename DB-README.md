# Database Component (`/db`)

Postgres is the shared state layer for Princeton Sentinel. It stores:

- latest-state Microsoft Graph inventory
- job definitions, schedules, runs, and run logs
- audit trails and revoke history
- Copilot telemetry and agent access data
- feature flags, graph sync mode state, license artifacts, and local testing state
- materialized views plus the refresh queue and dependency metadata used to keep dashboards current

## Bootstrap Layout

The bootstrap SQL that initializes a fresh database lives under [`db/init/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init):

- [`001_schema.sql`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init/001_schema.sql)
  Base tables, triggers, indexes, feature state tables, license tables, and MV refresh infrastructure.
- [`002_jobs.sql`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init/002_jobs.sql)
  Job seeds, schedule seeds, run tables, and run-log tables.
- [`003_materialized_views.sql`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init/003_materialized_views.sql)
  Dashboard and admin materialized views plus `mv_dependencies` registrations.
- [`004_audit.sql`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init/004_audit.sql)
  Audit event schema.
- [`005_revoke_permission_logs.sql`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/init/005_revoke_permission_logs.sql)
  Permission revoke log schema.

With Docker Compose, `db/init` is mounted into `/docker-entrypoint-initdb.d`, so those files run only on first database initialization.

## Schema Domains

### Graph inventory

The worker writes the Microsoft 365 latest-state model into:

- `msgraph_users`
- `msgraph_groups`
- `msgraph_sites`
- `msgraph_drives`
- `msgraph_drive_items`
- `msgraph_drive_item_permissions`
- `msgraph_drive_item_permission_grants`
- `msgraph_group_memberships`
- `msgraph_delta_state`

Design characteristics:

- latest-state storage with soft deletes via `deleted_at`
- raw Graph payload retention in `raw_json`
- delta cursor persistence in `msgraph_delta_state`
- permission sync health on `msgraph_drive_items`, including:
  - `permissions_last_synced_at`
  - `permissions_last_error_at`
  - `permissions_last_error`
  - `permissions_last_error_details`

### Jobs and operational state

- `jobs`
- `job_schedules`
- `job_runs`
- `job_run_logs`

Important constraints:

- `job_schedules` has a unique index on `job_id`, so scheduling is one-schedule-per-job
- `job_run_logs.run_id` references `job_runs.run_id` with `ON DELETE CASCADE`
- `job_runs` is one of the tracked sources for `mv_latest_job_runs`

### Copilot telemetry and agent access

Telemetry tables:

- `copilot_sessions`
- `copilot_events`
- `copilot_errors`
- `copilot_topic_stats`
- `copilot_tool_stats`
- `copilot_response_times`
- `copilot_tool_stats_hourly`
- `copilot_topic_stats_hourly`

Agent-control tables:

- `copilot_access_blocks`
- `copilot_agent_registrations`
- `agent_access_revoke_log`

These tables back the agents dashboard, Dataverse-backed access workflows, and admin agent access reporting.

### Feature, license, and local testing state

- `feature_flags`
- `graph_sync_mode_state`
- `license_artifacts`
- `active_license_artifact`
- `local_testing_state`

Important behavior:

- `feature_flags` currently seeds `agents_dashboard=true` and `test_mode=false`
- `graph_sync_mode_state` persists whether Graph sync is operating in `full` or `test` mode
- `license_artifacts` is immutable after insert; update/delete is rejected by trigger
- `active_license_artifact` holds the current active artifact slot
- `local_testing_state` drives local Docker license emulation

### Audit and revoke history

- `audit_events`
- `revoke_permission_logs`

These tables capture admin actions, job lifecycle events, and Graph permission revoke outcomes.

### Refresh bookkeeping

- `table_update_log`
- `mv_dependencies`
- `mv_refresh_log`
- `mv_refresh_queue`

## Materialized Views

The current bootstrap materialized views include:

### Inventory and high-level summaries

- `mv_msgraph_inventory_summary`
- `mv_msgraph_sharing_posture_summary`
- `mv_latest_job_runs`

### Sites, drives, and sharing

- `mv_msgraph_site_inventory`
- `mv_msgraph_routable_site_drives`
- `mv_msgraph_site_sharing_summary`
- `mv_msgraph_site_principal_identities`
- `mv_msgraph_site_external_principals`
- `mv_msgraph_link_breakdown`
- `mv_msgraph_sites_created_month`
- `mv_msgraph_site_activity_daily`

### Storage and usage

- `mv_msgraph_drive_storage_totals`
- `mv_msgraph_drive_type_counts`
- `mv_msgraph_storage_by_owner_site`
- `mv_msgraph_drive_top_used`

### Users, groups, and items

- `mv_msgraph_user_activity_daily`
- `mv_msgraph_group_member_counts`
- `mv_msgraph_item_link_daily`

### Copilot telemetry

- `mv_copilot_summary`

Each MV has a plain-column unique index so the worker can run `REFRESH MATERIALIZED VIEW CONCURRENTLY`.

## Triggered Update Model

Two trigger-driven systems matter for the application:

### Table freshness tracking

`touch_table_update_log()` updates `table_update_log.last_updated_at` whenever tracked base tables change.

This is used for:

- admin freshness displays
- feature-state versioning
- server-sent feature flag updates

### MV queue invalidation

`refresh_impacted_mvs()` looks up impacted view names in `mv_dependencies` and inserts them into `mv_refresh_queue`.

Important implication:

- write transactions do not refresh views directly
- the worker `mv_refresh` job drains `mv_refresh_queue` asynchronously
- `mv_refresh_log` records the last successful refresh time for each MV

### Feature-state notifications

`notify_feature_state_changed()` emits `pg_notify('ps_feature_state_changed', ...)` when these tables change:

- `feature_flags`
- `active_license_artifact`
- `local_testing_state`

The web app listens to that channel to update `/api/feature-flags/stream`.

## Seed Data

A fresh database currently seeds:

- jobs:
  - `graph_ingest`
  - `mv_refresh`
  - `copilot_telemetry`
- schedules:
  - `mv_refresh` enabled with cron `*/5 * * * *`
  - `copilot_telemetry` enabled with cron `*/60 * * * *`
  - no default schedule for `graph_ingest`
- feature flags:
  - `agents_dashboard=true`
  - `test_mode=false`
- local testing:
  - `local_testing_state('default')` with `emulate_license_enabled=true`

## Data Lifecycle Rules

- Most `msgraph_*` entities are soft-deleted rather than removed.
- Permission rows are hard-deleted selectively during resync replacement, item removal cleanup, and revoke reconciliation.
- Delta cursors in `msgraph_delta_state` are advanced only when stage writes succeed.
- `license_artifacts` is append-only history; clearing the current license only removes the active pointer, not historical rows.

## Migrations

Forward-only SQL changes live under [`db/migrations/`](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/db/migrations).

Run one migration with:

```bash
python3 scripts/db_migrations.py db/migrations/<migration_name>.sql
```

The helper is documented in [scripts/README.md](/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/README.md).

## Operational Notes

- The schema intentionally avoids many foreign keys across `msgraph_*` tables so ingest can stay resilient to partial refreshes and source-side inconsistencies.
- `mv_refresh_queue` and `mv_dependencies` are core to dashboard freshness; schema changes that add new tables or views usually need both trigger coverage and dependency metadata.
- Feature-flag, license, and local-testing updates are part of the runtime control plane, not just admin metadata.
- Copilot telemetry and agent access tables are first-class schema domains now; they are not sidecar experiments and should be treated as supported application state.
