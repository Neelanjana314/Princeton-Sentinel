CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_principal_identities AS
WITH grants AS (
  SELECT
    CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END AS site_key,
    LOWER(COALESCE(g.principal_email, g.principal_user_principal_name)) AS email,
    CASE
      WHEN POSITION('@' IN LOWER(COALESCE(g.principal_email, g.principal_user_principal_name))) > 0
        THEN SPLIT_PART(LOWER(COALESCE(g.principal_email, g.principal_user_principal_name)), '@', 2)
      ELSE NULL
    END AS email_domain,
    LOWER(COALESCE(g.principal_email, g.principal_user_principal_name)) LIKE '%#ext#%' AS is_guest,
    g.synced_at
  FROM msgraph_drive_item_permission_grants g
  JOIN msgraph_drive_item_permissions p
    ON p.drive_id = g.drive_id AND p.item_id = g.item_id AND p.permission_id = g.permission_id
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE g.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
    AND COALESCE(g.principal_email, g.principal_user_principal_name) IS NOT NULL
)
SELECT
  g.site_key,
  g.email,
  g.email_domain,
  BOOL_OR(g.is_guest) AS is_guest,
  MAX(g.synced_at) AS last_seen_at
FROM grants g
GROUP BY g.site_key, g.email, g.email_domain;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_principal_identities_uidx
ON mv_msgraph_site_principal_identities (site_key, email);

CREATE INDEX IF NOT EXISTS mv_msgraph_site_principal_identities_lookup_idx
ON mv_msgraph_site_principal_identities (site_key, is_guest, email_domain);

INSERT INTO mv_dependencies (mv_name, table_name) VALUES
  ('mv_msgraph_site_principal_identities', 'msgraph_sites'),
  ('mv_msgraph_site_principal_identities', 'msgraph_drives'),
  ('mv_msgraph_site_principal_identities', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_site_principal_identities', 'msgraph_drive_item_permission_grants')
ON CONFLICT DO NOTHING;

INSERT INTO mv_refresh_queue (mv_name, dirty_since, attempts, last_attempt_at)
VALUES ('mv_msgraph_site_principal_identities', now(), 0, NULL)
ON CONFLICT (mv_name) DO NOTHING;
