import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getInternalDomainPatterns } from "@/app/lib/internalDomains";
import { getPagination, getParam, getSortDirection, getWindowDays, SearchParams } from "@/app/lib/params";
import { buildSitePrincipalCountsCte } from "@/app/lib/site-principal-counts";
import { RiskTable } from "./risk-table";
import { RiskSummaryBarChartClient, RiskSummaryPieChartClient } from "@/components/risk-summary-graphs-client";
import PageHeader from "@/components/page-header";
import FilterBar from "@/components/filter-bar";

function buildSearchFilter(search: string | null) {
  if (!search) return { clause: "", params: [] as any[] };
  return {
    clause:
      "WHERE (LOWER(i.title) LIKE $1 OR LOWER(i.web_url) LIKE $1 OR LOWER(i.site_id) LIKE $1 OR LOWER(i.route_drive_id) LIKE $1 OR LOWER(i.site_key) LIKE $1)",
    params: [`%${search.toLowerCase()}%`],
  };
}

export const dynamic = "force-dynamic";

async function RiskPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const internalDomainPatterns = getInternalDomainPatterns();

  const search = getParam(resolvedSearchParams, "q");
  const dormantDays = Number(getParam(resolvedSearchParams, "dormantDays") || process.env.DASHBOARD_DORMANT_LOOKBACK_DAYS || 90);
  const windowDays = getWindowDays(resolvedSearchParams, 90);
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "flags";
  const dir = getSortDirection(resolvedSearchParams, "desc");

  const sortMap: Record<string, string> = {
    site: "title",
    flags: "flag_count",
    storage: "storage_used_bytes",
    lastActivity: "last_activity_dt",
  };
  const sortColumn = sortMap[sort] || "flag_count";

  const { clause, params } = buildSearchFilter(search);
  const dormantParamIndex = params.length + 1;
  const internalDomainParamIndex = params.length + 2;
  const flaggedBase = `
    WITH
    ${buildSitePrincipalCountsCte({ paramIndex: internalDomainParamIndex })}
    ,
    base AS (
      SELECT
        i.site_key,
        i.route_drive_id,
        i.title,
        i.web_url,
        i.is_personal,
        i.storage_used_bytes,
        i.storage_total_bytes,
        i.last_activity_dt,
        COALESCE(s.sharing_links, 0) AS sharing_links,
        COALESCE(s.anonymous_links, 0) AS anonymous_links,
        COALESCE(s.organization_links, 0) AS organization_links,
        COALESCE(pc.guest_users, 0) AS guest_users,
        COALESCE(pc.external_users, 0) AS external_users
      FROM mv_msgraph_routable_site_drives i
      LEFT JOIN mv_msgraph_site_sharing_summary s ON s.site_key = i.site_key
      LEFT JOIN principal_counts pc ON pc.site_key = i.site_key
      ${clause}
    ),
    flagged AS (
      SELECT
        b.*,
        (b.last_activity_dt IS NULL OR b.last_activity_dt < now() - ($${dormantParamIndex}::int * interval '1 day')) AS dormant,
        (COALESCE(b.anonymous_links, 0) > 0) AS "anonymousLinksSignal",
        (COALESCE(b.organization_links, 0) > 0) AS "orgLinksSignal",
        (COALESCE(b.external_users, 0) > 0) AS "externalUsersSignal",
        (COALESCE(b.guest_users, 0) > 0) AS "guestUsersSignal",
        (
          CASE WHEN (b.last_activity_dt IS NULL OR b.last_activity_dt < now() - ($${dormantParamIndex}::int * interval '1 day')) THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.anonymous_links, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.organization_links, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.external_users, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.guest_users, 0) > 0 THEN 1 ELSE 0 END
        )::int AS flag_count
      FROM base b
    ),
    filtered AS (
      SELECT * FROM flagged WHERE flag_count > 0
    )
  `;
  const graphFlaggedBase = `
    WITH
    ${buildSitePrincipalCountsCte({ paramIndex: 2 })}
    ,
    base AS (
      SELECT
        i.site_key,
        i.route_drive_id,
        i.title,
        i.web_url,
        i.is_personal,
        i.storage_used_bytes,
        i.storage_total_bytes,
        i.last_activity_dt,
        COALESCE(s.sharing_links, 0) AS sharing_links,
        COALESCE(s.anonymous_links, 0) AS anonymous_links,
        COALESCE(s.organization_links, 0) AS organization_links,
        COALESCE(pc.guest_users, 0) AS guest_users,
        COALESCE(pc.external_users, 0) AS external_users
      FROM mv_msgraph_routable_site_drives i
      LEFT JOIN mv_msgraph_site_sharing_summary s ON s.site_key = i.site_key
      LEFT JOIN principal_counts pc ON pc.site_key = i.site_key
    ),
    flagged AS (
      SELECT
        b.*,
        (b.last_activity_dt IS NULL OR b.last_activity_dt < now() - ($1::int * interval '1 day')) AS dormant,
        (COALESCE(b.anonymous_links, 0) > 0) AS "anonymousLinksSignal",
        (COALESCE(b.organization_links, 0) > 0) AS "orgLinksSignal",
        (COALESCE(b.external_users, 0) > 0) AS "externalUsersSignal",
        (COALESCE(b.guest_users, 0) > 0) AS "guestUsersSignal",
        (
          CASE WHEN (b.last_activity_dt IS NULL OR b.last_activity_dt < now() - ($1::int * interval '1 day')) THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.anonymous_links, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.organization_links, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.external_users, 0) > 0 THEN 1 ELSE 0 END +
          CASE WHEN COALESCE(b.guest_users, 0) > 0 THEN 1 ELSE 0 END
        )::int AS flag_count
      FROM base b
    ),
    filtered AS (
      SELECT * FROM flagged WHERE flag_count > 0
    )
  `;

  const countRows = await query<any>(
    `
    ${flaggedBase}
    SELECT COUNT(*)::int AS total
    FROM filtered
    `,
    [...params, dormantDays, internalDomainPatterns]
  );

  const totalFlagged = countRows[0]?.total || 0;
  const totalPages = Math.max(Math.ceil(totalFlagged / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;

  const [pageItems, topSitesRows, flagBreakdownRows, anonymousFileCountRows, orgFileCountRows] = await Promise.all([
    query<any>(
      `
      ${flaggedBase}
      SELECT
        site_key,
        route_drive_id,
        title,
        web_url,
        storage_used_bytes,
        storage_total_bytes,
        last_activity_dt,
        dormant,
        "anonymousLinksSignal",
        "orgLinksSignal",
        "externalUsersSignal",
        "guestUsersSignal",
        sharing_links,
        anonymous_links,
        organization_links,
        guest_users,
        external_users,
        flag_count
      FROM filtered
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${params.length + 3} OFFSET $${params.length + 4}
      `,
      [...params, dormantDays, internalDomainPatterns, pageSize, offset]
    ),
    query<any>(
      `
      ${graphFlaggedBase}
      SELECT title, route_drive_id, storage_used_bytes
      FROM filtered
      WHERE storage_used_bytes IS NOT NULL
      ORDER BY storage_used_bytes DESC NULLS LAST
      LIMIT 10
      `,
      [dormantDays, internalDomainPatterns]
    ),
    query<any>(
      `
      ${graphFlaggedBase}
      SELECT
        COUNT(*) FILTER (WHERE flag_count > 1)::int AS multiple_signals,
        COUNT(*) FILTER (WHERE flag_count = 1 AND "anonymousLinksSignal")::int AS anonymous_links,
        COUNT(*) FILTER (WHERE flag_count = 1 AND "orgLinksSignal")::int AS org_links,
        COUNT(*) FILTER (WHERE flag_count = 1 AND ("externalUsersSignal" OR "guestUsersSignal"))::int AS external_principals,
        COUNT(*) FILTER (WHERE flag_count = 1 AND dormant)::int AS dormant
      FROM filtered
      `,
      [dormantDays, internalDomainPatterns]
    ),
    query<any>(
      `
      SELECT
        COUNT(*)::int AS total
      FROM (
        SELECT i.drive_id, i.id
        FROM mv_msgraph_item_link_daily d
        JOIN msgraph_drive_items i ON i.drive_id = d.drive_id AND i.id = d.item_id
        JOIN msgraph_drives dr ON dr.id = i.drive_id
        WHERE d.link_scope = 'anonymous' AND i.deleted_at IS NULL AND dr.deleted_at IS NULL
          AND LOWER(COALESCE(dr.web_url, '')) NOT LIKE '%cachelibrary%'
          ${windowStart ? "AND d.day >= date_trunc('day', $1::timestamptz)" : ""}
        GROUP BY i.drive_id, i.id
      ) files
      `,
      windowStart ? [windowStart] : []
    ),
    query<any>(
      `
      SELECT
        COUNT(*)::int AS total
      FROM (
        SELECT i.drive_id, i.id
        FROM mv_msgraph_item_link_daily d
        JOIN msgraph_drive_items i ON i.drive_id = d.drive_id AND i.id = d.item_id
        JOIN msgraph_drives dr ON dr.id = i.drive_id
        WHERE d.link_scope = 'organization' AND i.deleted_at IS NULL AND dr.deleted_at IS NULL
          AND LOWER(COALESCE(dr.web_url, '')) NOT LIKE '%cachelibrary%'
          ${windowStart ? "AND d.day >= date_trunc('day', $1::timestamptz)" : ""}
        GROUP BY i.drive_id, i.id
      ) files
      `,
      windowStart ? [windowStart] : []
    ),
  ]);

  const topSites = topSitesRows.map((s: any) => ({
    title: s.title ?? s.route_drive_id,
    storageGB: s.storage_used_bytes ? s.storage_used_bytes / 1024 / 1024 / 1024 : 0,
  }));

  const flagRow = flagBreakdownRows[0] || {};
  const flagBreakdown: Record<string, number> = {
    Dormant: Number(flagRow.dormant || 0),
    "Anonymous links": Number(flagRow.anonymous_links || 0),
    "Org-wide links": Number(flagRow.org_links || 0),
    "External principals": Number(flagRow.external_principals || 0),
    "Multiple signals": Number(flagRow.multiple_signals || 0),
  };
  const multiSignalSites = Number(flagRow.multiple_signals || 0);
  const anonymousFileCount = Number(anonymousFileCountRows[0]?.total || 0);
  const orgFileCount = Number(orgFileCountRows[0]?.total || 0);

  return (
    <main className="ps-page">
      <PageHeader
        title="Risk"
        subtitle={`Site-level risk signals with file-level exposure detail. File window: ${windowDays ?? "all"}d.`}
      />
      <form action="/dashboard/risk" method="get">
        <FilterBar>
          <Input name="q" placeholder="Search sites…" defaultValue={search || ""} className="w-64" />
          <select
            name="days"
            defaultValue={windowDays == null ? "all" : String(windowDays)}
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            title="File window"
          >
            <option value="all">All-time</option>
            <option value="30">30d</option>
            <option value="90">90d</option>
            <option value="365">365d</option>
          </select>
          <select
            name="dormantDays"
            defaultValue={String(dormantDays)}
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            title="Dormant threshold"
          >
            <option value="30">Dormant 30d+</option>
            <option value="90">Dormant 90d+</option>
            <option value="180">Dormant 180d+</option>
            <option value="365">Dormant 365d+</option>
          </select>
          <Input name="pageSize" type="number" min={10} max={200} defaultValue={String(pageSize)} className="w-24" title="Page size" />
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </FilterBar>
      </form>

      <div className="grid gap-3 md:grid-cols-4">
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(totalFlagged)}</CardTitle>
            <CardDescription>Flagged sites</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(anonymousFileCount)}</CardTitle>
            <CardDescription>Files w/ anonymous links</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(orgFileCount)}</CardTitle>
            <CardDescription>Files w/ org links</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(multiSignalSites)}</CardTitle>
            <CardDescription>Multi-signal sites</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 my-2">
        <div className="w-full min-w-0">
          <RiskSummaryBarChartClient topSites={topSites} />
        </div>
        <div className="w-full min-w-0">
          <RiskSummaryPieChartClient flagBreakdown={flagBreakdown} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flagged sites</CardTitle>
          <CardDescription>
            {formatNumber(totalFlagged)} sites • showing {formatNumber(pageItems.length)}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <RiskTable items={pageItems} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/risk"
        page={clampedPage}
        pageSize={pageSize}
        totalItems={totalFlagged}
        extraParams={{
          q: search || undefined,
          pageSize,
          sort,
          dir,
          dormantDays,
          days: windowDays == null ? "all" : windowDays,
        }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/risk", RiskPage);
