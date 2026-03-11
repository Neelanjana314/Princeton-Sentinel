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

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_sharing_posture_summary AS
WITH eligible_permissions AS (
  SELECT p.*
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
),
eligible_grants AS (
  SELECT g.*
  FROM msgraph_drive_item_permission_grants g
  JOIN eligible_permissions p
    ON p.drive_id = g.drive_id AND p.item_id = g.item_id AND p.permission_id = g.permission_id
)
SELECT
  1 AS summary_id,
  (SELECT COUNT(*) FROM eligible_permissions) AS permissions_total,
  (SELECT COUNT(DISTINCT (drive_id, item_id)) FROM eligible_permissions) AS items_with_permissions,
  (SELECT COUNT(*) FROM eligible_permissions WHERE link_scope = 'anonymous') AS anonymous_links,
  (SELECT COUNT(*) FROM eligible_permissions WHERE link_scope = 'organization') AS organization_links,
  (SELECT COUNT(*) FROM eligible_permissions WHERE link_scope = 'users') AS users_links,
  (SELECT COUNT(*) FROM eligible_permissions WHERE link_type IS NULL) AS direct_shares,
  (SELECT COUNT(*) FROM eligible_grants WHERE principal_type = 'guest') AS guest_grants;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_sharing_posture_summary_uidx
ON mv_msgraph_sharing_posture_summary (summary_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_latest_job_runs AS
SELECT DISTINCT ON (job_id)
  job_id,
  run_id,
  started_at,
  finished_at,
  status,
  error
FROM job_runs
ORDER BY job_id, started_at DESC NULLS LAST;

CREATE UNIQUE INDEX IF NOT EXISTS mv_latest_job_runs_uidx
ON mv_latest_job_runs (job_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_inventory AS
WITH sharepoint_sites AS (
  SELECT
    s.id AS site_id,
    'site' AS source_type,
    s.name AS title,
    s.web_url,
    s.created_dt,
    s.raw_json,
    false AS is_personal
  FROM msgraph_sites s
  WHERE s.deleted_at IS NULL
    AND LOWER(COALESCE(s.web_url, '')) NOT LIKE '%cachelibrary%'
),
personal_sites AS (
  SELECT
    d.id AS site_id,
    'drive' AS source_type,
    d.name AS title,
    d.web_url,
    d.created_dt,
    NULL::jsonb AS raw_json,
    true AS is_personal
  FROM msgraph_drives d
  WHERE d.deleted_at IS NULL
    AND d.site_id IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
),
base AS (
  SELECT * FROM sharepoint_sites
  UNION ALL
  SELECT * FROM personal_sites
),
drive_stats AS (
  SELECT d.site_id, COUNT(*) AS drive_count, SUM(d.quota_used) AS storage_used, SUM(d.quota_total) AS storage_total
  FROM msgraph_drives d
  WHERE d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
personal_drive_stats AS (
  SELECT d.id AS site_id, 1 AS drive_count, d.quota_used AS storage_used, d.quota_total AS storage_total
  FROM msgraph_drives d
  WHERE d.deleted_at IS NULL
    AND d.site_id IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
),
last_write AS (
  SELECT d.site_id, MAX(i.modified_dt) AS last_write_dt
  FROM msgraph_drive_items i
  JOIN msgraph_drives d ON d.id = i.drive_id
  WHERE i.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
last_write_personal AS (
  SELECT i.drive_id AS site_id, MAX(i.modified_dt) AS last_write_dt
  FROM msgraph_drive_items i
  JOIN msgraph_drives d ON d.id = i.drive_id
  WHERE i.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY i.drive_id
),
last_share AS (
  SELECT d.site_id, MAX(p.synced_at) AS last_share_dt
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND p.link_scope IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
last_share_personal AS (
  SELECT p.drive_id AS site_id, MAX(p.synced_at) AS last_share_dt
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NULL
    AND p.link_scope IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY p.drive_id
)
SELECT
  CASE WHEN b.is_personal THEN 'drive:' || b.site_id ELSE b.site_id END AS site_key,
  b.site_id,
  b.source_type,
  b.title,
  b.web_url,
  b.created_dt,
  b.is_personal,
  b.raw_json->>'webTemplate' AS template,
  COALESCE(ds.drive_count, pds.drive_count, 0) AS drive_count,
  COALESCE(ds.storage_used, pds.storage_used, 0) AS storage_used_bytes,
  COALESCE(ds.storage_total, pds.storage_total, 0) AS storage_total_bytes,
  COALESCE(lw.last_write_dt, lwp.last_write_dt) AS last_write_dt,
  COALESCE(ls.last_share_dt, lsp.last_share_dt) AS last_share_dt,
  GREATEST(COALESCE(lw.last_write_dt, lwp.last_write_dt), COALESCE(ls.last_share_dt, lsp.last_share_dt)) AS last_activity_dt
FROM base b
LEFT JOIN drive_stats ds ON ds.site_id = b.site_id AND b.is_personal = false
LEFT JOIN personal_drive_stats pds ON pds.site_id = b.site_id AND b.is_personal = true
LEFT JOIN last_write lw ON lw.site_id = b.site_id AND b.is_personal = false
LEFT JOIN last_write_personal lwp ON lwp.site_id = b.site_id AND b.is_personal = true
LEFT JOIN last_share ls ON ls.site_id = b.site_id AND b.is_personal = false
LEFT JOIN last_share_personal lsp ON lsp.site_id = b.site_id AND b.is_personal = true;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_inventory_uidx
ON mv_msgraph_site_inventory (site_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_routable_site_drives AS
WITH eligible_drives AS (
  SELECT d.*
  FROM msgraph_drives d
  WHERE d.deleted_at IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
),
sharepoint_drive_ranked AS (
  SELECT
    d.site_id,
    d.id AS route_drive_id,
    d.drive_type,
    d.created_dt,
    ROW_NUMBER() OVER (
      PARTITION BY d.site_id
      ORDER BY
        CASE WHEN d.drive_type = 'documentLibrary' THEN 0 ELSE 1 END,
        d.created_dt ASC NULLS LAST,
        d.id ASC
    ) AS rank_in_site
  FROM eligible_drives d
  WHERE d.site_id IS NOT NULL
),
sharepoint_route_drives AS (
  SELECT site_id, route_drive_id
  FROM sharepoint_drive_ranked
  WHERE rank_in_site = 1
),
sharepoint_route_drive_meta AS (
  SELECT d.site_id, d.id AS route_drive_id, d.web_url AS route_drive_web_url, d.created_dt AS route_drive_created_dt
  FROM eligible_drives d
  JOIN sharepoint_route_drives srd ON srd.route_drive_id = d.id
),
sharepoint_drive_stats AS (
  SELECT
    d.site_id,
    COUNT(*)::int AS drive_count,
    SUM(d.quota_used) AS storage_used_bytes,
    SUM(d.quota_total) AS storage_total_bytes
  FROM msgraph_drives d
  WHERE d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
sharepoint_last_write AS (
  SELECT d.site_id, MAX(i.modified_dt) AS last_write_dt
  FROM msgraph_drive_items i
  JOIN msgraph_drives d ON d.id = i.drive_id
  WHERE i.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
sharepoint_last_share AS (
  SELECT d.site_id, MAX(p.synced_at) AS last_share_dt
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND p.link_scope IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
sharepoint_rows AS (
  SELECT
    srd.site_id AS site_key,
    srd.site_id,
    srd.route_drive_id,
    COALESCE(NULLIF(trim(s.name), ''), NULLIF(trim(s.raw_json->>'displayName'), ''), NULLIF(trim(s.raw_json->>'name'), ''), srd.site_id) AS title,
    COALESCE(s.web_url, rdm.route_drive_web_url) AS web_url,
    COALESCE(s.created_dt, rdm.route_drive_created_dt) AS created_dt,
    false AS is_personal,
    s.raw_json->>'webTemplate' AS template,
    COALESCE(ds.drive_count, 0) AS drive_count,
    COALESCE(ds.storage_used_bytes, 0) AS storage_used_bytes,
    COALESCE(ds.storage_total_bytes, 0) AS storage_total_bytes,
    lw.last_write_dt,
    ls.last_share_dt,
    GREATEST(lw.last_write_dt, ls.last_share_dt) AS last_activity_dt
  FROM sharepoint_route_drives srd
  LEFT JOIN msgraph_sites s ON s.id = srd.site_id AND s.deleted_at IS NULL
  LEFT JOIN sharepoint_route_drive_meta rdm ON rdm.route_drive_id = srd.route_drive_id
  LEFT JOIN sharepoint_drive_stats ds ON ds.site_id = srd.site_id
  LEFT JOIN sharepoint_last_write lw ON lw.site_id = srd.site_id
  LEFT JOIN sharepoint_last_share ls ON ls.site_id = srd.site_id
  WHERE LOWER(COALESCE(s.web_url, rdm.route_drive_web_url, '')) NOT LIKE '%cachelibrary%'
),
personal_last_write AS (
  SELECT i.drive_id, MAX(i.modified_dt) AS last_write_dt
  FROM msgraph_drive_items i
  WHERE i.deleted_at IS NULL
  GROUP BY i.drive_id
),
personal_last_share AS (
  SELECT p.drive_id, MAX(p.synced_at) AS last_share_dt
  FROM msgraph_drive_item_permissions p
  WHERE p.deleted_at IS NULL AND p.link_scope IS NOT NULL
  GROUP BY p.drive_id
),
personal_rows AS (
  SELECT
    'drive:' || d.id AS site_key,
    d.id AS site_id,
    d.id AS route_drive_id,
    COALESCE(u.display_name, d.owner_display_name, d.owner_email, d.name, d.id) AS title,
    d.web_url,
    d.created_dt,
    true AS is_personal,
    NULL::text AS template,
    1::int AS drive_count,
    COALESCE(d.quota_used, 0) AS storage_used_bytes,
    COALESCE(d.quota_total, 0) AS storage_total_bytes,
    lw.last_write_dt,
    ls.last_share_dt,
    GREATEST(lw.last_write_dt, ls.last_share_dt) AS last_activity_dt
  FROM eligible_drives d
  LEFT JOIN msgraph_users u ON u.id = d.owner_id AND u.deleted_at IS NULL
  LEFT JOIN personal_last_write lw ON lw.drive_id = d.id
  LEFT JOIN personal_last_share ls ON ls.drive_id = d.id
  WHERE d.site_id IS NULL
)
SELECT * FROM sharepoint_rows
UNION ALL
SELECT * FROM personal_rows;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_routable_site_drives_uidx
ON mv_msgraph_routable_site_drives (site_key);

CREATE INDEX IF NOT EXISTS mv_msgraph_routable_site_drives_last_activity_idx
ON mv_msgraph_routable_site_drives (last_activity_dt DESC, site_key);

CREATE INDEX IF NOT EXISTS mv_msgraph_routable_site_drives_created_idx
ON mv_msgraph_routable_site_drives (created_dt DESC, site_key);

CREATE INDEX IF NOT EXISTS mv_msgraph_routable_site_drives_storage_idx
ON mv_msgraph_routable_site_drives (storage_used_bytes DESC, site_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_sharing_summary AS
WITH base AS (
  SELECT site_key, site_id, is_personal
  FROM mv_msgraph_routable_site_drives
),
sharepoint_links AS (
  SELECT
    d.site_id AS site_id,
    COUNT(*) FILTER (WHERE p.link_scope IS NOT NULL) AS sharing_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'anonymous') AS anonymous_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'organization') AS organization_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'users') AS users_links,
    COUNT(*) FILTER (WHERE p.link_type IS NULL) AS direct_shares,
    MAX(p.synced_at) AS last_shared_at
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY d.site_id
),
personal_links AS (
  SELECT
    p.drive_id AS site_id,
    COUNT(*) FILTER (WHERE p.link_scope IS NOT NULL) AS sharing_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'anonymous') AS anonymous_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'organization') AS organization_links,
    COUNT(*) FILTER (WHERE p.link_scope = 'users') AS users_links,
    COUNT(*) FILTER (WHERE p.link_type IS NULL) AS direct_shares,
    MAX(p.synced_at) AS last_shared_at
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND d.site_id IS NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY p.drive_id
)
SELECT
  b.site_key,
  b.site_id,
  b.is_personal,
  COALESCE(s.sharing_links, pl.sharing_links, 0) AS sharing_links,
  COALESCE(s.anonymous_links, pl.anonymous_links, 0) AS anonymous_links,
  COALESCE(s.organization_links, pl.organization_links, 0) AS organization_links,
  COALESCE(s.users_links, pl.users_links, 0) AS users_links,
  COALESCE(s.direct_shares, pl.direct_shares, 0) AS direct_shares,
  COALESCE(s.last_shared_at, pl.last_shared_at) AS last_shared_at
FROM base b
LEFT JOIN sharepoint_links s ON s.site_id = b.site_id AND b.is_personal = false
LEFT JOIN personal_links pl ON pl.site_id = b.site_id AND b.is_personal = true;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_sharing_summary_uidx
ON mv_msgraph_site_sharing_summary (site_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_external_principals AS
WITH grants AS (
  SELECT
    CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END AS site_key,
    LOWER(COALESCE(g.principal_email, g.principal_user_principal_name)) AS email,
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
  COUNT(DISTINCT g.email) FILTER (WHERE g.email LIKE '%#ext#%')::int AS guest_users,
  COUNT(DISTINCT g.email) FILTER (WHERE g.email NOT LIKE '%#ext#%')::int AS external_users,
  MAX(g.synced_at) AS last_seen_at
FROM grants g
JOIN mv_msgraph_routable_site_drives rsd ON rsd.site_key = g.site_key
GROUP BY g.site_key;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_external_principals_uidx
ON mv_msgraph_site_external_principals (site_key);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_link_breakdown AS
SELECT
  p.link_scope,
  p.link_type,
  COUNT(*)::int AS count
FROM msgraph_drive_item_permissions p
JOIN msgraph_drives d ON d.id = p.drive_id
WHERE p.deleted_at IS NULL
  AND p.link_scope IS NOT NULL
  AND d.deleted_at IS NULL
  AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
GROUP BY p.link_scope, p.link_type;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_link_breakdown_uidx
ON mv_msgraph_link_breakdown (link_scope, link_type);

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

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_drive_top_used AS
SELECT
  ROW_NUMBER() OVER (ORDER BY quota_used DESC NULLS LAST) AS rank,
  id AS drive_id,
  name,
  drive_type,
  web_url,
  quota_used,
  quota_total
FROM msgraph_drives
WHERE deleted_at IS NULL
  AND LOWER(COALESCE(web_url, '')) NOT LIKE '%cachelibrary%'
ORDER BY quota_used DESC NULLS LAST
LIMIT 10;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_drive_top_used_uidx
ON mv_msgraph_drive_top_used (rank);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_sites_created_month AS
SELECT
  date_trunc('month', created_dt) AS month,
  COUNT(*)::int AS total_count,
  COUNT(*) FILTER (WHERE is_personal = true)::int AS personal_count,
  COUNT(*) FILTER (WHERE is_personal = false)::int AS sharepoint_count
FROM mv_msgraph_site_inventory
WHERE created_dt IS NOT NULL
GROUP BY date_trunc('month', created_dt)
ORDER BY month DESC;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_sites_created_month_uidx
ON mv_msgraph_sites_created_month (month);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_site_activity_daily AS
WITH mods AS (
  SELECT
    CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END AS site_key,
    date_trunc('day', i.modified_dt) AS day,
    COUNT(*)::int AS modified_items,
    COUNT(DISTINCT i.last_modified_by_user_id) FILTER (WHERE i.last_modified_by_user_id IS NOT NULL)::int AS active_users
  FROM msgraph_drive_items i
  JOIN msgraph_drives d ON d.id = i.drive_id
  WHERE i.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND i.modified_dt IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END, date_trunc('day', i.modified_dt)
),
shares AS (
  SELECT
    CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END AS site_key,
    date_trunc('day', p.synced_at) AS day,
    COUNT(*)::int AS shares
  FROM msgraph_drive_item_permissions p
  JOIN msgraph_drives d ON d.id = p.drive_id
  WHERE p.deleted_at IS NULL
    AND d.deleted_at IS NULL
    AND p.link_scope IS NOT NULL
    AND p.synced_at IS NOT NULL
    AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
  GROUP BY CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END, date_trunc('day', p.synced_at)
)
SELECT
  COALESCE(m.site_key, s.site_key) AS site_key,
  COALESCE(m.day, s.day) AS day,
  COALESCE(m.modified_items, 0) AS modified_items,
  COALESCE(m.active_users, 0) AS active_users,
  COALESCE(s.shares, 0) AS shares
FROM mods m
FULL OUTER JOIN shares s ON s.site_key = m.site_key AND s.day = m.day;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_site_activity_daily_uidx
ON mv_msgraph_site_activity_daily (site_key, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_user_activity_daily AS
SELECT
  i.last_modified_by_user_id AS user_id,
  date_trunc('day', i.modified_dt) AS day,
  COUNT(*)::int AS modified_items,
  COUNT(DISTINCT COALESCE(d.site_id, d.id))::int AS sites_touched,
  MAX(i.modified_dt) AS last_modified_dt
FROM msgraph_drive_items i
JOIN msgraph_drives d ON d.id = i.drive_id
WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL
  AND i.last_modified_by_user_id IS NOT NULL
  AND i.modified_dt IS NOT NULL
  AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
GROUP BY i.last_modified_by_user_id, date_trunc('day', i.modified_dt);

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_user_activity_daily_uidx
ON mv_msgraph_user_activity_daily (user_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_group_member_counts AS
SELECT
  group_id,
  COUNT(*)::int AS member_count
FROM msgraph_group_memberships
WHERE deleted_at IS NULL
GROUP BY group_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_group_member_counts_uidx
ON mv_msgraph_group_member_counts (group_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_msgraph_item_link_daily AS
SELECT
  p.drive_id,
  p.item_id,
  p.link_scope,
  date_trunc('day', p.synced_at) AS day,
  COUNT(*)::int AS link_shares
FROM msgraph_drive_item_permissions p
JOIN msgraph_drives d ON d.id = p.drive_id
WHERE p.deleted_at IS NULL
  AND p.link_scope IS NOT NULL
  AND p.synced_at IS NOT NULL
  AND d.deleted_at IS NULL
  AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
GROUP BY p.drive_id, p.item_id, p.link_scope, date_trunc('day', p.synced_at);

CREATE UNIQUE INDEX IF NOT EXISTS mv_msgraph_item_link_daily_uidx
ON mv_msgraph_item_link_daily (drive_id, item_id, link_scope, day);

CREATE UNIQUE INDEX IF NOT EXISTS mv_dependencies_uidx
ON mv_dependencies (mv_name, table_name);

INSERT INTO mv_dependencies (mv_name, table_name) VALUES
  ('mv_msgraph_inventory_summary', 'msgraph_users'),
  ('mv_msgraph_inventory_summary', 'msgraph_groups'),
  ('mv_msgraph_inventory_summary', 'msgraph_sites'),
  ('mv_msgraph_inventory_summary', 'msgraph_drives'),
  ('mv_msgraph_inventory_summary', 'msgraph_drive_items'),
  ('mv_msgraph_sharing_posture_summary', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_sharing_posture_summary', 'msgraph_drive_item_permission_grants'),
  ('mv_msgraph_sharing_posture_summary', 'msgraph_drives'),
  ('mv_latest_job_runs', 'job_runs'),
  ('mv_msgraph_site_inventory', 'msgraph_sites'),
  ('mv_msgraph_site_inventory', 'msgraph_drives'),
  ('mv_msgraph_site_inventory', 'msgraph_drive_items'),
  ('mv_msgraph_site_inventory', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_routable_site_drives', 'msgraph_sites'),
  ('mv_msgraph_routable_site_drives', 'msgraph_drives'),
  ('mv_msgraph_routable_site_drives', 'msgraph_drive_items'),
  ('mv_msgraph_routable_site_drives', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_routable_site_drives', 'msgraph_users'),
  ('mv_msgraph_site_sharing_summary', 'msgraph_sites'),
  ('mv_msgraph_site_sharing_summary', 'msgraph_drives'),
  ('mv_msgraph_site_sharing_summary', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_site_external_principals', 'msgraph_drives'),
  ('mv_msgraph_site_external_principals', 'msgraph_sites'),
  ('mv_msgraph_site_external_principals', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_site_external_principals', 'msgraph_drive_item_permission_grants'),
  ('mv_msgraph_link_breakdown', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_link_breakdown', 'msgraph_drives'),
  ('mv_msgraph_drive_storage_totals', 'msgraph_drives'),
  ('mv_msgraph_drive_type_counts', 'msgraph_drives'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_drives'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_users'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_sites'),
  ('mv_msgraph_storage_by_owner_site', 'msgraph_groups'),
  ('mv_msgraph_drive_top_used', 'msgraph_drives'),
  ('mv_msgraph_sites_created_month', 'msgraph_sites'),
  ('mv_msgraph_sites_created_month', 'msgraph_drives'),
  ('mv_msgraph_site_activity_daily', 'msgraph_drive_items'),
  ('mv_msgraph_site_activity_daily', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_site_activity_daily', 'msgraph_drives'),
  ('mv_msgraph_user_activity_daily', 'msgraph_drive_items'),
  ('mv_msgraph_user_activity_daily', 'msgraph_drives'),
  ('mv_msgraph_group_member_counts', 'msgraph_group_memberships'),
  ('mv_msgraph_item_link_daily', 'msgraph_drive_item_permissions'),
  ('mv_msgraph_item_link_daily', 'msgraph_drives')
ON CONFLICT DO NOTHING;
