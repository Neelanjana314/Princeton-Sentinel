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

CREATE OR REPLACE FUNCTION reject_license_artifact_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'license_artifacts are immutable';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_touch_license_artifacts'
      AND tgrelid = 'license_artifacts'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_license_artifacts
      AFTER INSERT OR UPDATE OR DELETE ON license_artifacts
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
    WHERE tgname = 'trg_touch_active_license_artifact'
      AND tgrelid = 'active_license_artifact'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_active_license_artifact
      AFTER INSERT OR UPDATE OR DELETE ON active_license_artifact
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
    WHERE tgname = 'trg_reject_license_artifact_update'
      AND tgrelid = 'license_artifacts'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_reject_license_artifact_update
      BEFORE UPDATE ON license_artifacts
      FOR EACH ROW EXECUTE FUNCTION reject_license_artifact_mutation()
    ';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_reject_license_artifact_delete'
      AND tgrelid = 'license_artifacts'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_reject_license_artifact_delete
      BEFORE DELETE ON license_artifacts
      FOR EACH ROW EXECUTE FUNCTION reject_license_artifact_mutation()
    ';
  END IF;
END;
$$;
