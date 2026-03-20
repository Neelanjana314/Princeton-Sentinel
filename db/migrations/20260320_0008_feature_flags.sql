CREATE TABLE IF NOT EXISTS feature_flags (
  feature_key text PRIMARY KEY,
  enabled boolean NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE OR REPLACE FUNCTION set_feature_flags_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_feature_flags_updated_at'
      AND tgrelid = 'feature_flags'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_feature_flags_updated_at
      BEFORE UPDATE ON feature_flags
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
    WHERE tgname = 'trg_touch_feature_flags'
      AND tgrelid = 'feature_flags'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_feature_flags
      AFTER INSERT OR UPDATE OR DELETE ON feature_flags
      FOR EACH ROW EXECUTE FUNCTION touch_table_update_log()
    ';
  END IF;
END;
$$;

INSERT INTO feature_flags (feature_key, enabled, description)
VALUES ('agents_dashboard', true, 'Enable the dashboard agents and copilot experience.')
ON CONFLICT (feature_key) DO NOTHING;

INSERT INTO table_update_log (table_name, last_updated_at)
VALUES (
  'feature_flags',
  COALESCE((SELECT MAX(updated_at) FROM feature_flags), now())
)
ON CONFLICT (table_name)
DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at;
