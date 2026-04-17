CREATE TABLE IF NOT EXISTS agent_quarantine_log (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    action                      TEXT NOT NULL,
    request_status              TEXT NOT NULL,
    actor_oid                   TEXT,
    actor_upn                   TEXT,
    actor_name                  TEXT,
    bot_id                      TEXT NOT NULL,
    bot_name                    TEXT,
    reason                      TEXT,
    resulting_is_quarantined    BOOLEAN,
    result_last_update_time_utc TIMESTAMPTZ,
    error_detail                TEXT,
    details                     JSONB
);

CREATE INDEX IF NOT EXISTS idx_agent_quarantine_log_occurred
ON agent_quarantine_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_quarantine_log_bot
ON agent_quarantine_log (bot_id, occurred_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'touch_table_update_log'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_touch_agent_quarantine_log'
      AND tgrelid = 'agent_quarantine_log'::regclass
  ) THEN
    EXECUTE '
      CREATE TRIGGER trg_touch_agent_quarantine_log
      AFTER INSERT OR UPDATE OR DELETE ON agent_quarantine_log
      FOR EACH ROW EXECUTE FUNCTION touch_table_update_log()
    ';
  END IF;
END $$;
