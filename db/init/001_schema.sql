CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Core ingestion tables
CREATE TABLE IF NOT EXISTS msgraph_users (
  id text PRIMARY KEY,
  display_name text,
  user_principal_name text,
  mail text,
  account_enabled boolean,
  user_type text,
  job_title text,
  department text,
  office_location text,
  usage_location text,
  created_dt timestamptz,
  synced_at timestamptz,
  is_available boolean NOT NULL DEFAULT true,
  last_available_at timestamptz,
  availability_checked_at timestamptz,
  availability_reason text,
  availability_error jsonb,
  deleted_at timestamptz,
  raw_json jsonb
);

CREATE TABLE IF NOT EXISTS msgraph_groups (
  id text PRIMARY KEY,
  display_name text,
  mail text,
  mail_enabled boolean,
  security_enabled boolean,
  group_types text[],
  visibility text,
  is_assignable_to_role boolean,
  created_dt timestamptz,
  synced_at timestamptz,
  deleted_at timestamptz,
  raw_json jsonb
);

CREATE TABLE IF NOT EXISTS msgraph_sites (
  id text PRIMARY KEY,
  name text,
  web_url text,
  hostname text,
  site_collection_id text,
  created_dt timestamptz,
  synced_at timestamptz,
  is_available boolean NOT NULL DEFAULT true,
  last_available_at timestamptz,
  availability_checked_at timestamptz,
  availability_reason text,
  availability_error jsonb,
  deleted_at timestamptz,
  raw_json jsonb
);

CREATE TABLE IF NOT EXISTS msgraph_drives (
  id text PRIMARY KEY,
  site_id text,
  name text,
  description text,
  drive_type text,
  web_url text,
  owner_id text,
  owner_type text,
  owner_display_name text,
  owner_email text,
  owner_graph_id text,
  created_by_user_id text,
  created_by_type text,
  created_by_display_name text,
  created_by_email text,
  created_by_graph_id text,
  last_modified_by_user_id text,
  last_modified_by_type text,
  last_modified_by_display_name text,
  last_modified_by_email text,
  last_modified_by_graph_id text,
  last_modified_dt timestamptz,
  quota_total bigint,
  quota_used bigint,
  quota_remaining bigint,
  quota_deleted bigint,
  quota_state text,
  created_dt timestamptz,
  synced_at timestamptz,
  is_available boolean NOT NULL DEFAULT true,
  last_available_at timestamptz,
  availability_checked_at timestamptz,
  availability_reason text,
  availability_error jsonb,
  deleted_at timestamptz,
  raw_json jsonb
);

CREATE TABLE IF NOT EXISTS msgraph_drive_items (
  drive_id text NOT NULL,
  id text NOT NULL,
  name text,
  web_url text,
  parent_id text,
  path text,
  normalized_path text,
  path_level int,
  is_folder boolean,
  child_count int,
  size bigint,
  mime_type text,
  file_hash_sha1 text,
  created_dt timestamptz,
  modified_dt timestamptz,
  created_by_user_id text,
  created_by_display_name text,
  created_by_email text,
  last_modified_by_user_id text,
  last_modified_by_display_name text,
  last_modified_by_email text,
  is_shared boolean,
  sp_site_id text,
  sp_list_id text,
  sp_list_item_id text,
  sp_list_item_unique_id text,
  permissions_last_synced_at timestamptz,
  permissions_last_error_at timestamptz,
  permissions_last_error text,
  permissions_last_error_details jsonb,
  synced_at timestamptz,
  deleted_at timestamptz,
  raw_json jsonb,
  PRIMARY KEY (drive_id, id)
);

CREATE TABLE IF NOT EXISTS msgraph_drive_item_permissions (
  permission_id text,
  drive_id text NOT NULL,
  item_id text NOT NULL,
  source text,
  roles text[],
  link_type text,
  link_scope text,
  link_web_url text,
  link_prevents_download boolean,
  link_expiration_dt timestamptz,
  inherited_from_id text,
  synced_at timestamptz,
  deleted_at timestamptz,
  raw_json jsonb,
  PRIMARY KEY (drive_id, item_id, permission_id)
);

CREATE TABLE IF NOT EXISTS msgraph_drive_item_permission_grants (
  permission_id text,
  drive_id text NOT NULL,
  item_id text NOT NULL,
  principal_type text,
  principal_id text,
  principal_display_name text,
  principal_email text,
  principal_user_principal_name text,
  synced_at timestamptz,
  deleted_at timestamptz,
  raw_json jsonb,
  PRIMARY KEY (drive_id, item_id, permission_id, principal_type, principal_id)
);

CREATE TABLE IF NOT EXISTS msgraph_group_memberships (
  group_id text NOT NULL,
  member_id text NOT NULL,
  member_type text NOT NULL,
  synced_at timestamptz,
  deleted_at timestamptz,
  raw_json jsonb,
  PRIMARY KEY (group_id, member_id, member_type)
);

CREATE TABLE IF NOT EXISTS msgraph_delta_state (
  resource_type text,
  partition_key text,
  delta_link text,
  last_synced_at timestamptz,
  PRIMARY KEY (resource_type, partition_key)
);

-- Copilot Studio telemetry tables
CREATE TABLE IF NOT EXISTS copilot_sessions (
  session_id text PRIMARY KEY,
  bot_id text,
  bot_name text,
  channel text,
  started_at timestamptz,
  ended_at timestamptz,
  outcome text,
  turn_count int DEFAULT 0,
  user_id text,
  user_name text,
  is_test boolean DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS copilot_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text REFERENCES copilot_sessions(session_id),
  event_name text NOT NULL,
  event_ts timestamptz NOT NULL,
  properties jsonb DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_copilot_events_dedup UNIQUE (session_id, event_name, event_ts)
);

CREATE TABLE IF NOT EXISTS copilot_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text,
  agent_name text,
  channel text,
  error_code text,
  error_message text,
  error_ts timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_copilot_errors_dedup UNIQUE (session_id, error_code, error_ts)
);

CREATE TABLE IF NOT EXISTS copilot_topic_stats (
  topic_name text PRIMARY KEY,
  avg_duration_sec numeric(10,2) DEFAULT 0,
  median_duration_sec numeric(10,2) DEFAULT 0,
  max_duration_sec numeric(10,2) DEFAULT 0,
  execution_count int DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copilot_tool_stats (
  tool_name text PRIMARY KEY,
  tool_type text,
  total_calls int DEFAULT 0,
  successful_calls int DEFAULT 0,
  failed_calls int DEFAULT 0,
  success_rate numeric(5,2) DEFAULT 0,
  avg_duration_sec numeric(10,2) DEFAULT 0,
  p50_duration_sec numeric(10,2) DEFAULT 0,
  p95_duration_sec numeric(10,2) DEFAULT 0,
  unique_conversations int DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS copilot_response_times (
  bot_id              TEXT        NOT NULL,
  channel             TEXT        NOT NULL DEFAULT '',
  is_test             BOOLEAN     NOT NULL DEFAULT false,
  time_bucket         TIMESTAMPTZ NOT NULL,
  avg_response_sec    NUMERIC(10,2) DEFAULT 0,
  p50_response_sec    NUMERIC(10,2) DEFAULT 0,
  p95_response_sec    NUMERIC(10,2) DEFAULT 0,
  p99_response_sec    NUMERIC(10,2) DEFAULT 0,
  total_responses     INT         DEFAULT 0,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, channel, is_test, time_bucket)
);

CREATE TABLE IF NOT EXISTS copilot_tool_stats_hourly (
  tool_name            TEXT        NOT NULL,
  bot_id               TEXT        NOT NULL,
  channel              TEXT        NOT NULL DEFAULT '',
  is_test              BOOLEAN     NOT NULL DEFAULT false,
  time_bucket          TIMESTAMPTZ NOT NULL,
  tool_type            TEXT,
  total_calls          INT         DEFAULT 0,
  successful_calls     INT         DEFAULT 0,
  failed_calls         INT         DEFAULT 0,
  success_rate         NUMERIC(5,2) DEFAULT 0,
  avg_duration_sec     NUMERIC(10,2) DEFAULT 0,
  p50_duration_sec     NUMERIC(10,2) DEFAULT 0,
  p95_duration_sec     NUMERIC(10,2) DEFAULT 0,
  unique_conversations INT         DEFAULT 0,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_name, bot_id, channel, is_test, time_bucket)
);

CREATE TABLE IF NOT EXISTS copilot_topic_stats_hourly (
  topic_name           TEXT        NOT NULL,
  bot_id               TEXT        NOT NULL,
  channel              TEXT        NOT NULL DEFAULT '',
  is_test              BOOLEAN     NOT NULL DEFAULT false,
  time_bucket          TIMESTAMPTZ NOT NULL,
  avg_duration_sec     NUMERIC(10,2) DEFAULT 0,
  median_duration_sec  NUMERIC(10,2) DEFAULT 0,
  max_duration_sec     NUMERIC(10,2) DEFAULT 0,
  execution_count      INT         DEFAULT 0,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_name, bot_id, channel, is_test, time_bucket)
);

-- Append-only event log for agent user block/unblock actions
CREATE TABLE IF NOT EXISTS agent_access_revoke_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    action          TEXT NOT NULL,
    admin_upn       TEXT,
    admin_name      TEXT,
    bot_id          TEXT NOT NULL,
    bot_name        TEXT,
    user_id         TEXT NOT NULL,
    user_name       TEXT,
    user_email      TEXT,
    reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_access_revoke_log_occurred
ON agent_access_revoke_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_access_revoke_log_bot
ON agent_access_revoke_log (bot_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_access_revoke_log_user
ON agent_access_revoke_log (user_id, occurred_at DESC);

-- Copilot agent access control
CREATE TABLE IF NOT EXISTS copilot_access_blocks (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id             TEXT NOT NULL,
    user_display_name   TEXT,
    user_principal_name TEXT,
    bot_id              TEXT NOT NULL,
    bot_name            TEXT,
    block_scope         TEXT NOT NULL DEFAULT 'agent',
    entra_policy_id     TEXT,
    entra_sync_status   TEXT NOT NULL DEFAULT 'not_applicable',
    entra_sync_error    TEXT,
    blocked_by          TEXT NOT NULL,
    blocked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    unblocked_at        TIMESTAMPTZ,
    unblocked_by        TEXT,
    block_reason        TEXT,
    unblock_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_copilot_access_blocks_active
ON copilot_access_blocks (bot_id, user_id)
WHERE unblocked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_copilot_access_blocks_user_active
ON copilot_access_blocks (user_id)
WHERE unblocked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_copilot_access_blocks_active
ON copilot_access_blocks (user_id, bot_id)
WHERE unblocked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_copilot_access_blocks_policy
ON copilot_access_blocks (entra_policy_id)
WHERE entra_policy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_copilot_access_blocks_audit
ON copilot_access_blocks (blocked_at DESC);

CREATE TABLE IF NOT EXISTS copilot_agent_registrations (
    bot_id              TEXT PRIMARY KEY,
    bot_name            TEXT,
    app_registration_id TEXT NOT NULL,
    app_object_id       TEXT,
    disabled_at         TIMESTAMPTZ,
    disabled_by         TEXT,
    disabled_reason     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copilot_agent_registrations_disabled
ON copilot_agent_registrations (bot_id)
WHERE disabled_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS feature_flags (
  feature_key text PRIMARY KEY,
  enabled boolean NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS graph_sync_mode_state (
  sync_key text PRIMARY KEY,
  mode text NOT NULL,
  group_id text,
  scope_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode IN ('full', 'test'))
);

CREATE OR REPLACE FUNCTION set_feature_flags_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_feature_flags_updated_at
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION set_feature_flags_updated_at();

INSERT INTO feature_flags (feature_key, enabled, description)
VALUES ('agents_dashboard', true, 'Enable the dashboard agents and copilot experience.')
ON CONFLICT (feature_key) DO NOTHING;

INSERT INTO feature_flags (feature_key, enabled, description)
VALUES ('test_mode', false, 'Scope Graph sync to the configured test group instead of the full tenant.')
ON CONFLICT (feature_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS license_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_license_text text NOT NULL,
  sha256 text NOT NULL,
  uploaded_by_oid text,
  uploaded_by_upn text,
  uploaded_by_name text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  verification_status text NOT NULL,
  verification_error text
);

CREATE TABLE IF NOT EXISTS active_license_artifact (
  slot text PRIMARY KEY,
  artifact_id uuid REFERENCES license_artifacts(artifact_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slot = 'default')
);

CREATE TABLE IF NOT EXISTS local_testing_state (
  state_key text PRIMARY KEY,
  emulate_license_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state_key = 'default')
);

CREATE OR REPLACE FUNCTION reject_license_artifact_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'license_artifacts are immutable';
END;
$$ LANGUAGE plpgsql;

-- Update tracking
CREATE TABLE IF NOT EXISTS table_update_log (
  table_name text PRIMARY KEY,
  last_updated_at timestamptz
);

CREATE OR REPLACE FUNCTION touch_table_update_log() RETURNS trigger AS $$
BEGIN
  INSERT INTO table_update_log (table_name, last_updated_at)
  VALUES (TG_TABLE_NAME, now())
  ON CONFLICT (table_name)
  DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notify_feature_state_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'ps_feature_state_changed',
    json_build_object(
      'table_name', TG_TABLE_NAME,
      'operation', TG_OP,
      'changed_at', now()
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_users
AFTER INSERT OR UPDATE OR DELETE ON msgraph_users
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_groups
AFTER INSERT OR UPDATE OR DELETE ON msgraph_groups
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_sites
AFTER INSERT OR UPDATE OR DELETE ON msgraph_sites
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_drives
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drives
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_drive_items
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_items
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_item_permissions
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_item_permissions
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_item_permission_grants
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_item_permission_grants
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_group_memberships
AFTER INSERT OR UPDATE OR DELETE ON msgraph_group_memberships
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_feature_flags
AFTER INSERT OR UPDATE OR DELETE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_license_artifacts
AFTER INSERT OR UPDATE OR DELETE ON license_artifacts
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_active_license_artifact
AFTER INSERT OR UPDATE OR DELETE ON active_license_artifact
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_touch_local_testing_state
AFTER INSERT OR UPDATE OR DELETE ON local_testing_state
FOR EACH ROW EXECUTE FUNCTION touch_table_update_log();

CREATE TRIGGER trg_notify_feature_flags_state
AFTER INSERT OR UPDATE OR DELETE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION notify_feature_state_changed();

CREATE TRIGGER trg_notify_active_license_feature_state
AFTER INSERT OR UPDATE OR DELETE ON active_license_artifact
FOR EACH ROW EXECUTE FUNCTION notify_feature_state_changed();

CREATE TRIGGER trg_notify_local_testing_state
AFTER INSERT OR UPDATE OR DELETE ON local_testing_state
FOR EACH ROW EXECUTE FUNCTION notify_feature_state_changed();

CREATE TRIGGER trg_local_testing_state_updated_at
BEFORE UPDATE ON local_testing_state
FOR EACH ROW EXECUTE FUNCTION set_feature_flags_updated_at();

CREATE TRIGGER trg_reject_license_artifact_update
BEFORE UPDATE ON license_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_license_artifact_mutation();

CREATE TRIGGER trg_reject_license_artifact_delete
BEFORE DELETE ON license_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_license_artifact_mutation();

INSERT INTO local_testing_state (state_key, emulate_license_enabled)
VALUES ('default', true)
ON CONFLICT (state_key) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_touch_copilot_access_blocks'
      AND tgrelid = 'copilot_access_blocks'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_copilot_access_blocks
      AFTER INSERT OR UPDATE OR DELETE ON copilot_access_blocks
      FOR EACH ROW EXECUTE FUNCTION touch_table_update_log()
    ';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_touch_copilot_agent_registrations'
      AND tgrelid = 'copilot_agent_registrations'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_copilot_agent_registrations
      AFTER INSERT OR UPDATE OR DELETE ON copilot_agent_registrations
      FOR EACH ROW EXECUTE FUNCTION touch_table_update_log()
    ';
  END IF;
END;
$$;

-- MV dependency metadata
CREATE TABLE IF NOT EXISTS mv_dependencies (
  mv_name text,
  table_name text
);

CREATE TABLE IF NOT EXISTS mv_refresh_log (
  mv_name text PRIMARY KEY,
  last_refreshed_at timestamptz
);

CREATE TABLE IF NOT EXISTS mv_refresh_queue (
  mv_name text PRIMARY KEY,
  dirty_since timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  attempts int NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION refresh_impacted_mvs() RETURNS trigger AS $$
DECLARE
  mv record;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  FOR mv IN SELECT DISTINCT mv_name FROM mv_dependencies WHERE table_name = TG_TABLE_NAME LOOP
    INSERT INTO mv_refresh_queue (mv_name, dirty_since)
    VALUES (mv.mv_name, now())
    ON CONFLICT (mv_name) DO NOTHING;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_drive_items_drive_id ON msgraph_drive_items (drive_id);
CREATE INDEX IF NOT EXISTS idx_drive_item_permissions_item_id ON msgraph_drive_item_permissions (drive_id, item_id);
CREATE INDEX IF NOT EXISTS idx_drive_item_permission_grants_item_id ON msgraph_drive_item_permission_grants (drive_id, item_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_group_id ON msgraph_group_memberships (group_id);
CREATE INDEX IF NOT EXISTS idx_drives_site_rank
ON msgraph_drives (site_id, drive_type, created_dt, id)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_drive_modified
ON msgraph_drive_items (drive_id, modified_dt DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_permissions_error_at
ON msgraph_drive_items (permissions_last_error_at DESC)
WHERE deleted_at IS NULL AND permissions_last_error_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_items_drive_modified_user
ON msgraph_drive_items (drive_id, modified_dt DESC, last_modified_by_user_id)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drive_item_permissions_drive_synced
ON msgraph_drive_item_permissions (drive_id, synced_at DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drive_item_permissions_scope_synced
ON msgraph_drive_item_permissions (link_scope, synced_at DESC)
WHERE deleted_at IS NULL AND link_scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drive_item_permission_grants_active_item
ON msgraph_drive_item_permission_grants (drive_id, item_id)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_copilot_sessions_started
ON copilot_sessions (started_at DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_copilot_sessions_bot
ON copilot_sessions (bot_id, started_at DESC)
WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_copilot_sessions_user
ON copilot_sessions (user_id)
WHERE deleted_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_copilot_events_session
ON copilot_events (session_id, event_ts);
CREATE INDEX IF NOT EXISTS idx_copilot_events_name_ts
ON copilot_events (event_name, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_errors_ts
ON copilot_errors (error_ts DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_errors_code
ON copilot_errors (error_code, error_ts DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_response_times_bucket
ON copilot_response_times (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_response_times_bot_bucket
ON copilot_response_times (bot_id, time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_response_times_channel
ON copilot_response_times (channel, time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_tool_stats_hourly_bucket
ON copilot_tool_stats_hourly (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_tool_stats_hourly_bot
ON copilot_tool_stats_hourly (bot_id, time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_tool_stats_hourly_channel
ON copilot_tool_stats_hourly (channel, time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_topic_stats_hourly_bucket
ON copilot_topic_stats_hourly (time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_topic_stats_hourly_bot
ON copilot_topic_stats_hourly (bot_id, time_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_topic_stats_hourly_channel
ON copilot_topic_stats_hourly (channel, time_bucket DESC);

-- Triggered MV queue invalidation on base table changes (statement-level)
CREATE TRIGGER trg_refresh_mvs_users
AFTER INSERT OR UPDATE OR DELETE ON msgraph_users
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_groups
AFTER INSERT OR UPDATE OR DELETE ON msgraph_groups
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_sites
AFTER INSERT OR UPDATE OR DELETE ON msgraph_sites
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_drives
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drives
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_drive_items
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_items
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_item_permissions
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_item_permissions
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_item_permission_grants
AFTER INSERT OR UPDATE OR DELETE ON msgraph_drive_item_permission_grants
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();

CREATE TRIGGER trg_refresh_mvs_group_memberships
AFTER INSERT OR UPDATE OR DELETE ON msgraph_group_memberships
FOR EACH STATEMENT EXECUTE FUNCTION refresh_impacted_mvs();
