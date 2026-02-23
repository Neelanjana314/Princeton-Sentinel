# Database Component (`/db`)

## Purpose
Postgres is the system-of-record and analytics store for Princeton Sentinel. It provides:

- Latest-state Microsoft Graph inventory tables
- Job/scheduling/run metadata
- Audit and revoke-operation logs
- Materialized views used by dashboard and admin pages
- Trigger-based freshness and refresh bookkeeping

Initialization SQL is in:

- `/db/init/001_schema.sql`
- `/db/init/002_jobs.sql`
- `/db/init/003_materialized_views.sql`
- `/db/init/004_audit.sql`
- `/db/init/005_revoke_permission_logs.sql`

---

## Bootstrap and Lifecycle

With Docker Compose, `db/init` is mounted to `/docker-entrypoint-initdb.d`, so SQL runs on first database initialization.

Compose service:

- Image: `postgres:16`
- Volume: `pgdata`
- Port: `5432`

---

## Schema Overview

## Core inventory tables (Graph latest-state model)

- `msgraph_users`
- `msgraph_groups`
- `msgraph_sites`
- `msgraph_drives`
- `msgraph_drive_items`
- `msgraph_drive_item_permissions`
- `msgraph_drive_item_permission_grants`
- `msgraph_group_memberships`
- `msgraph_delta_state`

### Design characteristics

- Soft-delete model on most entities via `deleted_at`
- Raw Graph payload captured in `raw_json jsonb`
- Delta cursors persisted in `msgraph_delta_state`
- Drive item permission sync health tracked on each item:
  - `permissions_last_synced_at`
  - `permissions_last_error_at`
  - `permissions_last_error`
  - `permissions_last_error_details`

## Operational/control-plane tables

- `jobs`
- `job_schedules`
- `job_runs`
- `job_run_logs`

`job_runs` has MV dependency for latest-run projection (`mv_latest_job_runs`).

## Auditing tables

- `audit_events`
- `revoke_permission_logs`

`revoke_permission_logs` stores success/failure/warning context for permission revoke actions performed from web UI.

## Refresh bookkeeping tables

- `table_update_log`
- `mv_dependencies`
- `mv_refresh_log`

---

## Key Primary Keys and Relationships

## Natural/Graph keys

- `msgraph_users.id`
- `msgraph_groups.id`
- `msgraph_sites.id`
- `msgraph_drives.id`
- `msgraph_drive_items (drive_id, id)`
- `msgraph_drive_item_permissions (drive_id, item_id, permission_id)`
- `msgraph_drive_item_permission_grants (drive_id, item_id, permission_id, principal_type, principal_id)`
- `msgraph_group_memberships (group_id, member_id, member_type)`
- `msgraph_delta_state (resource_type, partition_key)`

## Foreign keys (explicit)

- `job_schedules.job_id -> jobs.job_id`
- `job_runs.job_id -> jobs.job_id`
- `job_run_logs.run_id -> job_runs.run_id` (`ON DELETE CASCADE`)

Most `msgraph_*` relationships are maintained logically (by IDs) rather than foreign-key constraints.

---

## Trigger and Refresh System

## Table touch tracking

Function:

- `touch_table_update_log()`

Row-level triggers update `table_update_log.last_updated_at` for major ingestion and job tables.

## Materialized view refresh trigger

Function:

- `refresh_impacted_mvs()`

Behavior:

1. Read impacted MV names from `mv_dependencies` for the changed table.
2. Upsert impacted names into `mv_refresh_queue`.

Statement-level triggers invoke this after insert/update/delete on key base tables, including `job_runs`.

Important implication:

- Refreshes are queued asynchronously; write transactions do not execute full MV refreshes.
- Worker job `mv_refresh` performs `REFRESH MATERIALIZED VIEW CONCURRENTLY` on queued views.

---

## Materialized Views

Defined in `003_materialized_views.sql`.

## Summary/admin views

- `mv_msgraph_inventory_summary`
- `mv_msgraph_sharing_posture_summary`
- `mv_latest_job_runs`

## Site and sharing analytics views

- `mv_msgraph_site_inventory`
- `mv_msgraph_routable_site_drives`
- `mv_msgraph_site_sharing_summary`
- `mv_msgraph_site_external_principals`
- `mv_msgraph_link_breakdown`
- `mv_msgraph_sites_created_month`
- `mv_msgraph_site_activity_daily`

## Storage and ranking views

- `mv_msgraph_drive_storage_totals`
- `mv_msgraph_drive_type_counts`
- `mv_msgraph_drive_top_used`

## User/group/item rollups

- `mv_msgraph_user_activity_daily`
- `mv_msgraph_group_member_counts`
- `mv_msgraph_item_link_daily`

Each MV has a unique index for deterministic access and refresh support. For
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, this must be a plain-column unique
index (no expression keys and no `WHERE` predicate).

---

## Indexing

Base-table indexes include:

- `idx_drive_items_drive_id`
- `idx_drive_item_permissions_item_id`
- `idx_drive_item_permission_grants_item_id`
- `idx_group_memberships_group_id`
- `idx_drives_site_rank`
- `idx_drive_items_drive_modified`
- `idx_drive_items_drive_modified_user`
- `idx_drive_item_permissions_drive_synced`
- `idx_drive_item_permissions_scope_synced`
- `idx_drive_item_permission_grants_active_item`

Job subsystem indexes:

- `idx_job_run_logs_run_id_logged_at`
- `idx_job_schedules_next_run` (partial where enabled)
- `idx_job_runs_job_started`

Audit/revoke indexes:

- `idx_audit_events_occurred_at`
- `idx_audit_events_action`
- `idx_revoke_logs_occurred_at`
- `idx_revoke_logs_outcome_occurred`
- `idx_revoke_logs_actor_occurred`
- `idx_revoke_logs_item_occurred`

---

## Initial Seed Data

`002_jobs.sql` seeds one enabled `graph_ingest` job with default JSON config and no default schedule.

This is why first-time environments require schedule creation from admin UI before periodic runs begin.

---

## Data Lifecycle Rules

## Soft-deletion strategy

Worker generally upserts seen records and marks missing/stale records with `deleted_at` instead of hard deletion.

Hard deletes are used selectively for permission tables during:

- item removal cleanup
- permission rescan replacement
- explicit revoke synchronization

## Delta cursors

`msgraph_delta_state` holds:

- `resource_type` (`sites`, `drive_items`, etc.)
- `partition_key` (global or per-drive)
- `delta_link`
- `last_synced_at`

Worker resets/updates these based on Graph delta behavior (including 410 expiration handling).

---

## Integration Contracts

## Worker -> DB (primary writes)

Worker writes inventory, job run state, run logs, and audit events.

## Web -> DB (control/read/write)

Web reads summaries/details for all dashboards and writes:

- job and schedule admin changes
- audit events for admin/API actions
- revoke operation logs
- local cache cleanup after successful Graph permission deletion

## DB -> Web/Worker (shared state)

Both components rely on:

- consistent table schemas and columns
- MV names and semantics
- refresh log timestamps for "last refreshed" display

---

## Migrations and Change Management

`db/init` currently contains bootstrap SQL files used at first initialization.

A migration runner exists:

- `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/db_migrations.py`

Current note:

- Migration files are stored under `db/migrations`.
- Run via `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/db_migrations.py` as documented in `/Users/garrick-mac/Documents/GitHub/Princeton-Sentinel/scripts/README.md`.

---

## Operational Considerations

- Trigger-driven MV refreshing is simple but can be expensive under high write throughput.
- Lack of FKs among many `msgraph_*` tables improves ingest flexibility but requires application-level consistency discipline.
- Permission tables can grow quickly in large tenants; monitor size/index maintenance and VACUUM behavior.
- Soft-deleted rows remain queryable unless filters enforce `deleted_at IS NULL`.
