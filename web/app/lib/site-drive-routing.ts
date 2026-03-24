export const DRIVE_SITE_KEY_EXPR = "CASE WHEN d.site_id IS NULL THEN 'drive:' || d.id ELSE d.site_id END";

export const ROUTABLE_SITE_DRIVES_CTE = `
  WITH routable_site_drives AS (
    SELECT
      site_key,
      site_id,
      route_drive_id,
      title,
      web_url,
      created_dt,
      is_personal,
      is_available,
      last_available_at,
      availability_reason,
      template,
      drive_count,
      storage_used_bytes,
      storage_total_bytes,
      last_write_dt,
      last_share_dt,
      last_activity_dt
    FROM mv_msgraph_routable_site_drives
  )
`;
