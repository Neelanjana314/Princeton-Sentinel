import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatBytes, formatIsoDate, formatIsoDateTime, formatNumber, safeDecode } from "@/app/lib/format";
import { getParam, getWindowDays, SearchParams } from "@/app/lib/params";
import { getInternalDomainPatterns } from "@/app/lib/internalDomains";

import { SiteActivityTrendTable, SiteTopUsersTable } from "./site-detail-tables";
import { SiteAvailabilityNotice } from "./site-availability-notice";

export const dynamic = "force-dynamic";

async function DriveDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ driveId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  await requireUser();

  const { driveId: encodedDriveId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const driveId = safeDecode(encodedDriveId);
  const windowDays = getWindowDays(resolvedSearchParams, 90);
  const daysParam = getParam(resolvedSearchParams, "days") || "90";
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const driveRows = await query<any>(
    `
    WITH last_write AS (
      SELECT MAX(COALESCE(i.modified_dt, i.created_dt)) AS last_write_dt
      FROM msgraph_drive_items i
      WHERE i.deleted_at IS NULL AND i.drive_id = $1
    ),
    last_share AS (
      SELECT MAX(p.synced_at) AS last_share_dt
      FROM msgraph_drive_item_permissions p
      WHERE p.deleted_at IS NULL AND p.drive_id = $1 AND p.link_scope IS NOT NULL
    )
    SELECT
      d.id AS drive_id,
      d.site_id,
      d.name AS drive_name,
      d.drive_type,
      d.web_url AS drive_web_url,
      d.created_dt,
      d.is_available,
      d.last_available_at,
      d.availability_reason,
      d.quota_used AS storage_used_bytes,
      d.quota_total AS storage_total_bytes,
      d.owner_display_name,
      d.owner_email,
      u.display_name AS owner_user_name,
      s.name AS site_name,
      s.web_url AS site_web_url,
      s.raw_json->>'webTemplate' AS site_template,
      lw.last_write_dt,
      ls.last_share_dt,
      lw.last_write_dt AS last_activity_dt
    FROM msgraph_drives d
    LEFT JOIN msgraph_users u ON u.id = d.owner_id AND u.deleted_at IS NULL
    LEFT JOIN msgraph_sites s ON s.id = d.site_id AND s.deleted_at IS NULL
    CROSS JOIN last_write lw
    CROSS JOIN last_share ls
    WHERE d.id = $1
      AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
    LIMIT 1
    `,
    [driveId]
  );

  const drive = driveRows[0];
  if (!drive) notFound();

  const isPersonal = !drive.site_id;
  const title = isPersonal
    ? drive.owner_user_name || drive.owner_display_name || drive.owner_email || drive.drive_name || drive.drive_id
    : drive.site_name || drive.drive_name || drive.site_id || drive.drive_id;
  const template = isPersonal ? null : drive.site_template;
  const displayUrl = isPersonal ? drive.drive_web_url : drive.site_web_url || drive.drive_web_url;

  const activitySummaryRows = await query<any>(
    `
    SELECT
      (
        SELECT COUNT(*)::int
        FROM msgraph_drive_items i
        WHERE i.deleted_at IS NULL
          AND i.drive_id = $1
          AND i.modified_dt IS NOT NULL
          ${windowStart ? "AND i.modified_dt >= $2" : ""}
      ) AS modified_items,
      (
        SELECT COUNT(*)::int
        FROM msgraph_drive_item_permissions p
        WHERE p.deleted_at IS NULL
          AND p.drive_id = $1
          AND p.link_scope IS NOT NULL
          AND p.synced_at IS NOT NULL
          ${windowStart ? "AND p.synced_at >= $2" : ""}
      ) AS shares
    `,
    windowStart ? [driveId, windowStart] : [driveId]
  );

  const activitySeriesRows = await query<any>(
    `
    WITH mods AS (
      SELECT date_trunc('day', i.modified_dt) AS day, COUNT(*)::int AS modified_items
      FROM msgraph_drive_items i
      WHERE i.deleted_at IS NULL
        AND i.drive_id = $1
        AND i.modified_dt IS NOT NULL
        ${windowStart ? "AND i.modified_dt >= $2" : ""}
      GROUP BY date_trunc('day', i.modified_dt)
    ),
    shares AS (
      SELECT date_trunc('day', p.synced_at) AS day, COUNT(*)::int AS shares
      FROM msgraph_drive_item_permissions p
      WHERE p.deleted_at IS NULL
        AND p.drive_id = $1
        AND p.link_scope IS NOT NULL
        AND p.synced_at IS NOT NULL
        ${windowStart ? "AND p.synced_at >= $2" : ""}
      GROUP BY date_trunc('day', p.synced_at)
    )
    SELECT
      COALESCE(m.day, s.day) AS day,
      COALESCE(m.modified_items, 0) AS modified_items,
      COALESCE(s.shares, 0) AS shares
    FROM mods m
    FULL OUTER JOIN shares s ON s.day = m.day
    ORDER BY day DESC
    LIMIT 90
    `,
    windowStart ? [driveId, windowStart] : [driveId]
  );

  const accessCounts = await query<any>(
    `
    WITH perms AS (
      SELECT p.drive_id, p.item_id, p.permission_id, p.link_scope
      FROM msgraph_drive_item_permissions p
      WHERE p.deleted_at IS NULL AND p.drive_id = $1
    ),
    grants AS (
      SELECT g.principal_type, g.principal_id
      FROM msgraph_drive_item_permission_grants g
      JOIN perms p ON p.drive_id = g.drive_id AND p.item_id = g.item_id AND p.permission_id = g.permission_id
      WHERE g.deleted_at IS NULL
    )
    SELECT
      (SELECT COUNT(DISTINCT principal_id) FROM grants WHERE principal_type = 'user')::int AS direct_users,
      (SELECT COUNT(DISTINCT principal_id) FROM grants WHERE principal_type IN ('group', 'siteGroup'))::int AS group_grants,
      (SELECT COUNT(*) FROM perms WHERE link_scope IS NOT NULL)::int AS sharing_links
    `,
    [driveId]
  );

  const patterns = getInternalDomainPatterns();
  const sharingRisk = await query<any>(
    `
    WITH distinct_emails AS (
      SELECT DISTINCT COALESCE(g.principal_email, g.principal_user_principal_name) AS email
      FROM msgraph_drive_item_permission_grants g
      JOIN msgraph_drive_item_permissions p
        ON p.drive_id = g.drive_id AND p.item_id = g.item_id AND p.permission_id = g.permission_id
      WHERE g.deleted_at IS NULL AND p.deleted_at IS NULL
        AND p.drive_id = $1
        AND COALESCE(g.principal_email, g.principal_user_principal_name) IS NOT NULL
    )
    SELECT
      (
        SELECT COUNT(*)
        FROM msgraph_drive_item_permissions p
        WHERE p.deleted_at IS NULL
          AND p.drive_id = $1
          AND p.link_scope = 'anonymous'
      )::int AS anonymous_links,
      COUNT(*) FILTER (WHERE email ILIKE '%#EXT#%')::int AS guest_users,
      COUNT(*) FILTER (
        WHERE email NOT ILIKE '%#EXT#%'
          AND COALESCE(array_length($2::text[], 1), 0) > 0
          AND NOT (split_part(lower(email), '@', 2) LIKE ANY($2::text[]))
      )::int AS external_users
    FROM distinct_emails
    `,
    [driveId, patterns]
  );

  const topUsers = await query<any>(
    `
    SELECT
      i.last_modified_by_user_id AS user_id,
      COUNT(*)::int AS modified_items,
      MAX(i.modified_dt) AS last_modified_dt,
      u.display_name,
      u.mail,
      u.user_principal_name
    FROM msgraph_drive_items i
    LEFT JOIN msgraph_users u ON u.id = i.last_modified_by_user_id
    WHERE i.deleted_at IS NULL
      AND i.drive_id = $1
      AND i.last_modified_by_user_id IS NOT NULL
      ${windowStart ? "AND i.modified_dt >= $2" : ""}
    GROUP BY i.last_modified_by_user_id, u.display_name, u.mail, u.user_principal_name
    ORDER BY modified_items DESC
    LIMIT 10
    `,
    windowStart ? [driveId, windowStart] : [driveId]
  );

  const activitySummary = activitySummaryRows[0] || { modified_items: 0, shares: 0 };
  const access = accessCounts[0] || {};
  const risk = sharingRisk[0] || {};

  const series = activitySeriesRows
    .map((row: any) => ({
      date: row.day ? new Date(row.day).toISOString().slice(0, 10) : "--",
      modifiedItems: row.modified_items ?? 0,
      shares: row.shares ?? 0,
    }))
    .sort((a: any, b: any) => (a.date < b.date ? 1 : -1));

  const maxModified = Math.max(...series.map((p: any) => p.modifiedItems), 0);
  const maxShares = Math.max(...series.map((p: any) => p.shares), 0);

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold">{title}</h1>
            {template ? <Badge variant="outline">{template}</Badge> : null}
            {isPersonal ? <Badge variant="outline">Personal</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Created {formatIsoDate(drive.created_dt)} • Last activity {formatIsoDateTime(drive.last_activity_dt)}
          </p>
          {displayUrl ? (
            <a className="text-sm text-muted-foreground hover:underline" href={displayUrl} target="_blank" rel="noreferrer">
              {displayUrl}
            </a>
          ) : null}
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Cached (DB)</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link className="text-muted-foreground hover:underline" href="/dashboard/sites">
            Back
          </Link>
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}/sharing`}>
            Sharing
          </Link>
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}/files`}>
            Files
          </Link>
          <form className="flex items-center gap-2" action={`/sites/${encodeURIComponent(driveId)}`} method="get">
            <select
              name="days"
              defaultValue={daysParam}
              className="h-9 rounded-md border border-input bg-background px-2 py-1 text-sm"
              title="Window"
            >
              <option value="all">All-time</option>
              <option value="7">7d</option>
              <option value="30">30d</option>
              <option value="90">90d</option>
              <option value="365">365d</option>
            </select>
            <button className="text-muted-foreground hover:underline" type="submit">
              Apply
            </button>
          </form>
        </div>
      </div>

      <SiteAvailabilityNotice
        isAvailable={drive.is_available}
        lastAvailableAt={drive.last_available_at}
        availabilityReason={drive.availability_reason}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Storage</CardTitle>
            <CardDescription>Current usage (drive quota)</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Used</span>
              <span className="font-medium">{formatBytes(drive.storage_used_bytes)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Allocated</span>
              <span className="font-medium">{formatBytes(drive.storage_total_bytes)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Drives</span>
              <span className="font-medium">1</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Window: {windowDays == null ? "All-time" : `${windowDays}d`}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Items last modified</span>
              <span className="font-medium">{formatNumber(activitySummary.modified_items || 0)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Link permissions seen</span>
              <span className="font-medium">{formatNumber(activitySummary.shares || 0)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Last write</span>
              <span className="font-medium">{formatIsoDateTime(drive.last_write_dt)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sharing risk</CardTitle>
            <CardDescription>Derived from permissions</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Anonymous links</span>
              <span className="font-medium">{formatNumber(risk.anonymous_links || 0)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Guest users</span>
              <span className="font-medium">{formatNumber(risk.guest_users || 0)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">External users</span>
              <span className="font-medium">{formatNumber(risk.external_users || 0)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity trend</CardTitle>
          <CardDescription>
            Distribution by date from item timestamps and cached permission sync observations (window: {windowDays == null ? "All-time" : `${windowDays}d`})
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SiteActivityTrendTable points={series} maxModified={maxModified} maxShares={maxShares} windowDays={windowDays} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Access model</CardTitle>
          <CardDescription>How access is granted</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-muted-foreground">Direct users</div>
              <div className="text-xl font-semibold">{formatNumber(access.direct_users || 0)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-muted-foreground">Groups</div>
              <div className="text-xl font-semibold">{formatNumber(access.group_grants || 0)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-muted-foreground">Sharing links</div>
              <div className="text-xl font-semibold">{formatNumber(access.sharing_links || 0)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top active users</CardTitle>
          <CardDescription>Users who are currently `lastModifiedBy` for items (window: {windowDays == null ? "All-time" : `${windowDays}d`})</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SiteTopUsersTable
            users={topUsers.map((row: any) => ({
              userId: row.user_id,
              displayName: row.display_name,
              email: row.mail || row.user_principal_name,
              modifiedItems: row.modified_items || 0,
              lastModifiedDateTime: row.last_modified_dt,
            }))}
          />
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/sites/[driveId]", DriveDetailPage);
