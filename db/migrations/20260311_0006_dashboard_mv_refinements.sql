-- Refine dashboard-facing materialized views so /dashboard can stay MV-backed
-- while using the updated business rules for site/user/drive/storage metrics.

DROP MATERIALIZED VIEW IF EXISTS mv_msgraph_storage_by_owner_site;
DROP MATERIALIZED VIEW IF EXISTS mv_msgraph_drive_type_counts;
DROP MATERIALIZED VIEW IF EXISTS mv_msgraph_drive_storage_totals;
DROP MATERIALIZED VIEW IF EXISTS mv_msgraph_inventory_summary;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_inventory_summary AS
WITH eligible_drives AS (
  SELECT d.*
  FROM msgraph_drives d
  WHERE LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
),
dashboard_sharepoint_sites AS (
  SELECT s.id
  FROM msgraph_sites s
  WHERE s.deleted_at IS NULL
    AND NOT (
      COALESCE((s.raw_json->>'isPersonalSite') = 'true', false)
      OR LOWER(COALESCE(s.hostname, '')) LIKE '%my.sharepoint.com'
      OR LOWER(COALESCE(s.web_url, '')) LIKE '%/personal/%'
    )
    AND EXISTS (
      SELECT 1
      FROM msgraph_drives d
      WHERE d.site_id = s.id
        AND d.deleted_at IS NULL
        AND COALESCE(d.drive_type, '') <> 'cacheLibrary'
    )
),
eligible_drive_items AS (
  SELECT i.*
  FROM msgraph_drive_items i
  JOIN eligible_drives d ON d.id = i.drive_id
)
SELECT
  1 AS summary_id,
  (SELECT COUNT(*) FROM msgraph_users) AS users_total,
  (SELECT COUNT(*) FROM msgraph_users WHERE deleted_at IS NULL AND account_enabled IS TRUE) AS active_users_total,
  (SELECT COUNT(*) FROM msgraph_users WHERE deleted_at IS NOT NULL) AS users_deleted,
  (SELECT MAX(synced_at) FROM msgraph_users) AS users_last_synced_at,
  (SELECT COUNT(*) FROM msgraph_groups) AS groups_total,
  (SELECT COUNT(*) FROM msgraph_groups WHERE deleted_at IS NOT NULL) AS groups_deleted,
  (SELECT MAX(synced_at) FROM msgraph_groups) AS groups_last_synced_at,
  (SELECT COUNT(*) FROM msgraph_sites s WHERE LOWER(COALESCE(s.web_url, '')) NOT LIKE '%cachelibrary%') AS sites_total,
  (SELECT COUNT(*) FROM dashboard_sharepoint_sites) AS sharepoint_sites_total,
  (SELECT COUNT(*) FROM msgraph_sites s WHERE s.deleted_at IS NOT NULL AND LOWER(COALESCE(s.web_url, '')) NOT LIKE '%cachelibrary%') AS sites_deleted,
  (SELECT MAX(s.synced_at) FROM msgraph_sites s WHERE LOWER(COALESCE(s.web_url, '')) NOT LIKE '%cachelibrary%') AS sites_last_synced_at,
  (SELECT COUNT(*) FROM eligible_drives) AS drives_total,
  (SELECT COUNT(*) FROM msgraph_drives d WHERE COALESCE(d.name, '') <> 'PersonalCacheLibrary') AS drives_total_excluding_personal_cache_library,
  (SELECT COUNT(*) FROM eligible_drives WHERE deleted_at IS NOT NULL) AS drives_deleted,
  (SELECT MAX(synced_at) FROM eligible_drives) AS drives_last_synced_at,
  (SELECT COUNT(*) FROM eligible_drive_items) AS drive_items_total,
  (SELECT COUNT(*) FROM eligible_drive_items WHERE deleted_at IS NOT NULL) AS drive_items_deleted,
  (SELECT MAX(synced_at) FROM eligible_drive_items) AS drive_items_last_synced_at;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_inventory_summary_uidx
ON mv_msgraph_inventory_summary (summary_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_drive_storage_totals AS
SELECT
  1 AS summary_id,
  SUM(quota_used) AS storage_used,
  SUM(quota_total) AS storage_total
FROM msgraph_drives
WHERE deleted_at IS NULL
  AND COALESCE(name, '') <> 'PersonalCacheLibrary';

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_drive_storage_totals_uidx
ON mv_msgraph_drive_storage_totals (summary_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_drive_type_counts AS
SELECT
  drive_type,
  COUNT(*)::int AS count
FROM msgraph_drives
WHERE deleted_at IS NULL
  AND COALESCE(name, '') <> 'PersonalCacheLibrary'
GROUP BY drive_type;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_drive_type_counts_uidx
ON mv_msgraph_drive_type_counts (drive_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_storage_by_owner_site AS
WITH labeled_drives AS (
  SELECT
    COALESCE(
      NULLIF(trim(s.name), ''),
      NULLIF(trim(g.display_name), ''),
      NULLIF(trim(u.display_name), ''),
      NULLIF(trim(d.owner_display_name), ''),
      NULLIF(trim(d.owner_email), ''),
      NULLIF(trim(d.name), ''),
      d.id
    ) AS label,
    COALESCE(d.quota_used, 0) AS quota_used
  FROM msgraph_drives d
  LEFT JOIN msgraph_users u ON u.id = d.owner_id AND u.deleted_at IS NULL
  LEFT JOIN msgraph_sites s ON s.id = d.site_id AND s.deleted_at IS NULL
  LEFT JOIN msgraph_groups g ON g.id = d.owner_id AND g.deleted_at IS NULL
  WHERE d.deleted_at IS NULL
    AND COALESCE(d.name, '') <> 'PersonalCacheLibrary'
),
aggregated AS (
  SELECT label, SUM(quota_used)::bigint AS quota_used
  FROM labeled_drives
  GROUP BY label
)
SELECT
  ROW_NUMBER() OVER (ORDER BY quota_used DESC NULLS LAST, label ASC) AS rank,
  label,
  quota_used
FROM aggregated
ORDER BY quota_used DESC NULLS LAST, label ASC
LIMIT 10;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_storage_by_owner_site_uidx
ON mv_msgraph_storage_by_owner_site (rank);

INSERT INTO mv_dependencies (mv_name, table_name) VALUES
  ('mv_msgraph_inventory_summary', 'msgraph_users'),
  ('mv_msgraph_inventory_summary', 'msgraph_groups'),
  ('mv_msgraph_inventory_summary', 'msgraph_sites'),
  ('mv_msgraph_inventory_summary', 'msgraph_drives'),
  ('mv_msgraph_inventory_summary', 'msgraph_drive_items'),
  ('mv_msgraph_drive_storage_totals', 'msgraph_drives'),
  ('mv_msgraph_drive_type_counts', 'msgraph_drives'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_drives'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_users'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_sites'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_groups')
ON CONFLICT DO NOTHING;

INSERT INTO mv_refresh_queue (mv_name, dirty_since, attempts, last_attempt_at) VALUES
  ('mv_msgraph_inventory_summary', now(), 0, NULL),
  ('mv_msgraph_drive_storage_totals', now(), 0, NULL),
  ('mv_msgraph_drive_type_counts', now(), 0, NULL),
  ('mv_msgraph_storage_by_owner_site', now(), 0, NULL)
ON CONFLICT (mv_name) DO UPDATE
SET dirty_since = EXCLUDED.dirty_since,
    attempts = 0,
    last_attempt_at = NULL;
