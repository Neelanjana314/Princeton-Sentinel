CREATE TABLE IF NOT EXISTS local_testing_state (
  state_key text PRIMARY KEY,
  emulate_license_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state_key = 'default')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_local_testing_state_updated_at'
      AND tgrelid = 'local_testing_state'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_local_testing_state_updated_at
      BEFORE UPDATE ON local_testing_state
      FOR EACH ROW EXECUTE FUNCTION set_feature_flags_updated_at()
    ';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_touch_local_testing_state'
      AND tgrelid = 'local_testing_state'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_local_testing_state
      AFTER INSERT OR UPDATE OR DELETE ON local_testing_state
      FOR EACH ROW EXECUTE FUNCTION touch_table_update_log()
    ';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_notify_local_testing_state'
      AND tgrelid = 'local_testing_state'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_notify_local_testing_state
      AFTER INSERT OR UPDATE OR DELETE ON local_testing_state
      FOR EACH ROW EXECUTE FUNCTION notify_feature_state_changed()
    ';
  END IF;
END;
$$;

INSERT INTO local_testing_state (state_key, emulate_license_enabled)
VALUES ('default', true)
ON CONFLICT (state_key) DO NOTHING;

INSERT INTO table_update_log (table_name, last_updated_at)
VALUES (
  'local_testing_state',
  COALESCE((SELECT MAX(updated_at) FROM local_testing_state), now())
)
ON CONFLICT (table_name)
DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at;
