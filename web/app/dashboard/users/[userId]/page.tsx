import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/pagination";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatIsoDateTime, safeDecode } from "@/app/lib/format";
import { getPagination, getParam, getWindowDays, SearchParams } from "@/app/lib/params";
import { DRIVE_SITE_KEY_EXPR, ROUTABLE_SITE_DRIVES_CTE } from "@/app/lib/site-drive-routing";
import PageHeader from "@/components/page-header";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

import { UserRecentItemsTable, UserTopSitesTable } from "./user-detail-tables";

export const dynamic = "force-dynamic";

async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  await requireUser();

  const { userId: encodedUserId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const userId = safeDecode(encodedUserId);
  const windowDays = getParam(resolvedSearchParams, "days") ? getWindowDays(resolvedSearchParams, 90) : null;
  const daysParam = getParam(resolvedSearchParams, "days") || "all";
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 25 });

  const userRows = await query<any>(
    `
    SELECT
      id,
      display_name,
      mail,
      user_principal_name,
      user_type,
      department,
      job_title,
      created_dt,
      synced_at,
      is_available,
      last_available_at,
      availability_reason
    FROM msgraph_users
    WHERE id = $1 AND deleted_at IS NULL
    `,
    [userId]
  );
  const user = userRows[0];
  if (!user) notFound();

  const summaryRows = await query<any>(
    `
    SELECT
      COUNT(*)::int AS modified_items,
      COUNT(DISTINCT COALESCE(d.site_id, d.id))::int AS sites_touched,
      MAX(i.modified_dt) AS last_modified_dt
    FROM msgraph_drive_items i
    JOIN msgraph_drives d ON d.id = i.drive_id
    WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
      AND i.last_modified_by_user_id = $1
      ${windowStart ? "AND i.modified_dt >= $2" : ""}
    `,
    windowStart ? [userId, windowStart] : [userId]
  );

  const topSites = await query<any>(
    `
    ${ROUTABLE_SITE_DRIVES_CTE}
    , top_site_activity AS (
      SELECT
        ${DRIVE_SITE_KEY_EXPR} AS site_key,
        COUNT(*)::int AS modified_items,
        MAX(i.modified_dt) AS last_modified_dt
      FROM msgraph_drive_items i
      JOIN msgraph_drives d ON d.id = i.drive_id
      WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL
        AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
        AND i.last_modified_by_user_id = $1
        ${windowStart ? "AND i.modified_dt >= $2" : ""}
      GROUP BY ${DRIVE_SITE_KEY_EXPR}
      ORDER BY modified_items DESC
      LIMIT 10
    )
    SELECT
      rsd.route_drive_id AS site_drive_id,
      rsd.title,
      rsd.web_url,
      tsa.modified_items,
      tsa.last_modified_dt
    FROM top_site_activity tsa
    JOIN routable_site_drives rsd ON rsd.site_key = tsa.site_key
    ORDER BY tsa.modified_items DESC
    `,
    windowStart ? [userId, windowStart] : [userId]
  );

  const countRows = await query<any>(
    `
    SELECT COUNT(*)::int AS total
    FROM msgraph_drive_items i
    JOIN msgraph_drives d ON d.id = i.drive_id
    WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
      AND i.last_modified_by_user_id = $1
      ${windowStart ? "AND i.modified_dt >= $2" : ""}
    `,
    windowStart ? [userId, windowStart] : [userId]
  );

  const total = countRows[0]?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;

  const recentItems = await query<any>(
    `
    ${ROUTABLE_SITE_DRIVES_CTE}
    SELECT
      i.drive_id,
      i.id,
      i.name,
      i.web_url,
      i.normalized_path,
      i.path,
      i.modified_dt,
      rsd.route_drive_id AS site_drive_id,
      rsd.title AS site_title
    FROM msgraph_drive_items i
    JOIN msgraph_drives d ON d.id = i.drive_id
    LEFT JOIN routable_site_drives rsd ON rsd.site_key = ${DRIVE_SITE_KEY_EXPR}
    WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
      AND i.last_modified_by_user_id = $1
      ${windowStart ? "AND i.modified_dt >= $2" : ""}
    ORDER BY i.modified_dt DESC NULLS LAST
    LIMIT $${windowStart ? 3 : 2} OFFSET $${windowStart ? 4 : 3}
    `,
    windowStart ? [userId, windowStart, pageSize, offset] : [userId, pageSize, offset]
  );

  const summary = summaryRows[0] || {};
  const displayName = user?.display_name || user?.mail || user?.user_principal_name || userId;
  const primaryIdentifier = user?.mail || user?.user_principal_name || userId;
  const availabilityLabel = user?.is_available === false ? "Unavailable" : "Available";
  const availabilityDetail = user?.is_available === false
    ? user?.availability_reason || formatIsoDateTime(user?.last_available_at)
    : formatIsoDateTime(user?.last_available_at);

  return (
    <main className="ps-page">
      <PageHeader
        title={displayName}
        subtitle={`Directory profile for ${primaryIdentifier}. Activity panels below use the ${windowDays == null ? "all-time" : `${windowDays}d`} window.`}
        actions={
          <>
            <Link className="text-muted-foreground hover:underline" href="/dashboard/users">
              Users
            </Link>
            <form className="flex flex-wrap items-center gap-2" action={`/dashboard/users/${encodeURIComponent(userId)}`} method="get">
              <select
                name="days"
                defaultValue={daysParam}
                className="h-9 rounded-md border border-input bg-background px-2 py-1 text-sm"
                title="Activity window"
              >
                <option value="all">All-time</option>
                <option value="7">7d</option>
                <option value="30">30d</option>
                <option value="90">90d</option>
                <option value="365">365d</option>
              </select>
              <Input
                name="pageSize"
                type="number"
                min={10}
                max={200}
                defaultValue={String(pageSize)}
                className="h-9 w-24"
                title="Page size"
              />
              <Button type="submit" variant="outline" size="sm">
                Apply
              </Button>
            </form>
          </>
        }
      />

      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{userId}</p>
        <p>Created {formatIsoDateTime(user.created_dt)} • Last synced {formatIsoDateTime(user.synced_at)}</p>
      </div>

      <MetricGrid className="xl:grid-cols-4">
        <MetricCard label="User Type" value={user.user_type ?? "—"} />
        <MetricCard label="Department" value={user.department ?? "—"} />
        <MetricCard label="Job Title" value={user.job_title ?? "—"} />
        <MetricCard label="Availability" value={availabilityLabel} detail={availabilityDetail} />
      </MetricGrid>

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{Number(summary.modified_items || 0).toLocaleString()}</CardTitle>
            <CardDescription>Items last modified ({windowDays == null ? "All-time" : `${windowDays}d`})</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{Number(summary.sites_touched || 0).toLocaleString()}</CardTitle>
            <CardDescription>Sites touched ({windowDays == null ? "All-time" : `${windowDays}d`})</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">{formatIsoDateTime(summary.last_modified_dt)}</CardTitle>
            <CardDescription>Last modified activity</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top sites by activity</CardTitle>
          <CardDescription>Sites where this user is currently `lastModifiedBy` for items (window: {windowDays == null ? "All-time" : `${windowDays}d`})</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <UserTopSitesTable
            sites={topSites.map((row: any) => ({
              driveId: row.site_drive_id,
              title: row.title,
              webUrl: row.web_url,
              modifiedItems: row.modified_items || 0,
              lastModifiedDateTime: row.last_modified_dt,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently modified items</CardTitle>
          <CardDescription>
            {total.toLocaleString()} items • showing {recentItems.length.toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto space-y-3">
          <UserRecentItemsTable
            items={recentItems.map((row: any) => ({
              itemId: `${row.drive_id}::${row.id}`,
              name: row.name || row.id,
              webUrl: row.web_url,
              normalizedPath: row.normalized_path || row.path,
              lastModifiedDateTime: row.modified_dt,
              siteDriveId: row.site_drive_id,
              siteTitle: row.site_title,
            }))}
          />
          <Pagination
            pathname={`/dashboard/users/${encodeURIComponent(userId)}`}
            page={clampedPage}
            pageSize={pageSize}
            totalItems={total}
            extraParams={{ days: windowDays == null ? "all" : String(windowDays), pageSize }}
          />
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/dashboard/users/[userId]", UserDetailPage);
