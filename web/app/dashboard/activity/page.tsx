import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getPagination, getParam, getSortDirection, getWindowDays, SearchParams } from "@/app/lib/params";
import { ActivityTable } from "./activity-table";
import ActivitySummaryGraphsWrapper from "@/components/activity-summary-graphs-wrapper";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, formatSearchFilterValue } from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

function buildActivityFilter(search: string | null, siteType: string | null) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const index = params.length;
    clauses.push(
      `(LOWER(title) LIKE $${index} OR LOWER(web_url) LIKE $${index} OR LOWER(site_id) LIKE $${index} OR LOWER(site_key) LIKE $${index} OR LOWER(route_drive_id) LIKE $${index})`
    );
  }

  if (siteType === "personal") {
    clauses.push("is_personal = true");
  } else if (siteType === "nonPersonal") {
    clauses.push("COALESCE(is_personal, false) = false");
  }

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function buildSiteTypeClause(siteType: string | null) {
  if (siteType === "personal") return "WHERE is_personal = true";
  if (siteType === "nonPersonal") return "WHERE COALESCE(is_personal, false) = false";
  return "";
}

function formatSiteTypeFilter(value: string) {
  if (value === "personal") return "Personal";
  if (value === "nonPersonal") return "Non-personal";
  return "All sites";
}

function formatWindowFilter(days: number | null) {
  return days == null ? "All-time" : `${days}d`;
}

export const dynamic = "force-dynamic";

async function ActivityPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const siteType = getParam(resolvedSearchParams, "siteType") || "all";
  const windowDays = getWindowDays(resolvedSearchParams, 90);
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "lastActivity";
  const dir = getSortDirection(resolvedSearchParams, "desc");

  const sortMap: Record<string, string> = {
    site: "title",
    availability: "is_available",
    lastAvailable: "last_available_at",
    modified: "modified_items",
    shares: "shares",
    activeUsers: "active_users",
    storage: "storage_used_bytes",
    lastActivity: "last_activity_dt",
  };
  const sortColumn = sortMap[sort] || "last_activity_dt";
  const { clause, params } = buildActivityFilter(search, siteType);
  const summaryParams = windowStart ? [...params, windowStart] : [...params];
  const graphSiteTypeClause = buildSiteTypeClause(siteType);
  const graphSummaryParams = windowStart ? [windowStart] : [];
  const activityBaseCte = `
      WITH base AS (
        SELECT site_key, route_drive_id, title, web_url, is_personal, template, is_available, last_available_at,
               availability_reason, storage_used_bytes, storage_total_bytes, last_activity_dt
        FROM mv_msgraph_routable_site_drives
        ${clause}
      ), activity AS (
        SELECT
          d.site_key,
          COALESCE(SUM(d.modified_items), 0)::int AS modified_items,
          COALESCE(SUM(d.active_users), 0)::int AS active_users,
          COALESCE(SUM(d.shares), 0)::int AS shares
        FROM mv_msgraph_site_activity_daily d
        JOIN base b ON b.site_key = d.site_key
        ${windowStart ? `WHERE d.day >= date_trunc('day', $${params.length + 1}::timestamptz)` : ""}
        GROUP BY d.site_key
      )
    `;
  const graphActivityBaseCte = `
      WITH base AS (
        SELECT site_key, route_drive_id, title, web_url, is_personal, template, is_available, last_available_at,
               availability_reason, storage_used_bytes, storage_total_bytes, last_activity_dt
        FROM mv_msgraph_routable_site_drives
        ${graphSiteTypeClause}
      ), activity AS (
        SELECT
          d.site_key,
          COALESCE(SUM(d.modified_items), 0)::int AS modified_items,
          COALESCE(SUM(d.active_users), 0)::int AS active_users,
          COALESCE(SUM(d.shares), 0)::int AS shares
        FROM mv_msgraph_site_activity_daily d
        JOIN base b ON b.site_key = d.site_key
        ${windowStart ? `WHERE d.day >= date_trunc('day', $1::timestamptz)` : ""}
        GROUP BY d.site_key
      )
    `;
  const [countRows, dataRows, topSitesByActiveUsersRows, topSitesBySharesModsRows] = await Promise.all([
    query<any>("SELECT COUNT(*)::int AS total FROM mv_msgraph_routable_site_drives " + clause, params),
    query<any>(
      `
      ${activityBaseCte}
      SELECT
        b.*,
        COALESCE(a.modified_items, 0) AS modified_items,
        COALESCE(a.active_users, 0) AS active_users,
        COALESCE(a.shares, 0) AS shares
      FROM base b
      LEFT JOIN activity a ON a.site_key = b.site_key
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${summaryParams.length + 1} OFFSET $${summaryParams.length + 2}
      `,
      [...summaryParams, pageSize, offset]
    ),
    query<any>(
      `
      ${graphActivityBaseCte}
      SELECT
        b.title,
        b.route_drive_id,
        COALESCE(a.active_users, 0) AS active_users
      FROM base b
      LEFT JOIN activity a ON a.site_key = b.site_key
      ORDER BY active_users DESC NULLS LAST, b.title ASC NULLS LAST, b.route_drive_id ASC
      LIMIT 10
      `,
      graphSummaryParams
    ),
    query<any>(
      `
      ${graphActivityBaseCte}
      SELECT
        b.title,
        b.route_drive_id,
        COALESCE(a.shares, 0) AS shares,
        COALESCE(a.modified_items, 0) AS modified_items
      FROM base b
      LEFT JOIN activity a ON a.site_key = b.site_key
      ORDER BY (COALESCE(a.shares, 0) + COALESCE(a.modified_items, 0)) DESC NULLS LAST, b.title ASC NULLS LAST, b.route_drive_id ASC
      LIMIT 10
      `,
      graphSummaryParams
    ),
  ]);
  const total = countRows[0]?.total || 0;

  const topSitesByActiveUsers = topSitesByActiveUsersRows.map((row) => ({
    title: row.title || row.route_drive_id,
    activeUsers: row.active_users,
  }));

  const topSitesBySharesMods = topSitesBySharesModsRows.map((row) => ({
    title: row.title || row.route_drive_id,
    shares: row.shares,
    mods: row.modified_items,
  }));

  return (
    <main className="ps-page">
      <PageHeader
        title="Activity"
        subtitle={`Based on item timestamps and cached link-permission sync observations. Window: ${windowDays ?? "all"}d.`}
      />

      <form action="/dashboard/activity" method="get">
        <FilterBar>
          <FilterField label="Search">
            <Input name="q" placeholder="Search sites..." defaultValue={search || ""} className="w-64" />
          </FilterField>
          <FilterField label="Site type">
            <select
              name="siteType"
              defaultValue={siteType}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="all">All sites</option>
              <option value="personal">Personal</option>
              <option value="nonPersonal">Non-personal</option>
            </select>
          </FilterField>
          <FilterField label="Activity window">
            <select
              name="days"
              defaultValue={windowDays == null ? "all" : String(windowDays)}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="all">All-time</option>
              <option value="7">7d</option>
              <option value="30">30d</option>
              <option value="90">90d</option>
              <option value="365">365d</option>
            </select>
          </FilterField>
          <FilterField label="Page size">
            <Input
              name="pageSize"
              type="number"
              min={10}
              max={200}
              defaultValue={String(pageSize)}
              className="w-24"
            />
          </FilterField>
          <Button type="submit" variant="outline" className="self-end">
            Apply
          </Button>
          <AppliedFilterTags
            tags={[
              { label: "Search", value: formatSearchFilterValue(search) },
              { label: "Site type", value: formatSiteTypeFilter(siteType) },
              { label: "Activity window", value: formatWindowFilter(windowDays) },
              { label: "Page size", value: pageSize },
            ]}
          />
        </FilterBar>
      </form>

      <MetricGrid className="md:grid-cols-1 lg:grid-cols-1">
        <MetricCard label="Total Sites" value={formatNumber(total)} className="max-w-sm" />
      </MetricGrid>

      <ActivitySummaryGraphsWrapper
        topSitesByActiveUsers={topSitesByActiveUsers}
        topSitesBySharesMods={topSitesBySharesMods}
        windowDays={windowDays}
      />

      <Card>
        <CardHeader>
          <CardTitle>Sites</CardTitle>
          <CardDescription>
            {formatNumber(total)} sites • showing {formatNumber(dataRows.length)}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ActivityTable items={dataRows} windowDays={windowDays} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/activity"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{
          q: search || undefined,
          pageSize,
          sort,
          dir,
          days: windowDays == null ? "all" : windowDays,
          siteType: siteType === "all" ? undefined : siteType,
        }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/activity", ActivityPage);
