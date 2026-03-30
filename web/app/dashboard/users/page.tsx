import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getPagination, getParam, getSortDirection, getWindowDays, SearchParams } from "@/app/lib/params";
import { UsersTable } from "./users-table";
import { UsersSummaryBarChartClient } from "@/components/users-summary-graphs-wrapper";
import PageHeader from "@/components/page-header";
import FilterBar from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

function buildSearchClause(search: string | null) {
  if (!search) return { clause: "", params: [] as any[] };
  const pattern = `%${search.toLowerCase()}%`;
  const clause = `
    AND (
      LOWER(COALESCE(u.display_name, '')) LIKE $1
      OR LOWER(COALESCE(u.mail, '')) LIKE $1
      OR LOWER(COALESCE(u.user_principal_name, '')) LIKE $1
      OR LOWER(u.id) LIKE $1
    )
  `;
  return { clause, params: [pattern] };
}

export const dynamic = "force-dynamic";

async function UsersPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const windowDays = getParam(resolvedSearchParams, "days") ? getWindowDays(resolvedSearchParams, 90) : null;
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "user";
  const dir = getSortDirection(resolvedSearchParams, "asc");

  const sortMap: Record<string, string> = {
    user: "COALESCE(display_name, mail, user_principal_name, user_id)",
    email: "COALESCE(mail, user_principal_name, '')",
    type: "user_type",
    department: "department",
    title: "job_title",
    synced: "synced_at",
  };
  const sortColumn = sortMap[sort] || sortMap.user;

  const searchClause = buildSearchClause(search);
  const params = [...searchClause.params];
  const usersDirectoryCte = `
    WITH filtered AS (
      SELECT
        u.id AS user_id,
        u.display_name,
        u.mail,
        u.user_principal_name,
        u.user_type,
        u.department,
        u.job_title,
        u.synced_at
      FROM msgraph_users u
      WHERE 1=1
        AND u.deleted_at IS NULL
        AND u.account_enabled IS TRUE
        ${searchClause.clause}
    )
  `;
  const graphActivityParams = windowStart ? [windowStart] : [];
  const usersActivityCte = `
    WITH filtered_users AS (
      SELECT
        u.id AS user_id,
        u.display_name,
        u.mail,
        u.user_principal_name
      FROM msgraph_users u
      WHERE 1=1
        AND u.deleted_at IS NULL
        AND u.account_enabled IS TRUE
    ), activity AS (
      SELECT
        i.last_modified_by_user_id AS user_id,
        COUNT(*)::int AS modified_items,
        COUNT(DISTINCT COALESCE(d.site_id, d.id))::int AS sites_touched
      FROM msgraph_drive_items i
      JOIN msgraph_drives d ON d.id = i.drive_id
      WHERE i.deleted_at IS NULL
        AND d.deleted_at IS NULL
        AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
        AND i.last_modified_by_user_id IS NOT NULL
        ${windowStart ? "AND i.modified_dt >= $1" : ""}
      GROUP BY i.last_modified_by_user_id
    ), filtered AS (
      SELECT
        fu.user_id,
        fu.display_name,
        fu.mail,
        fu.user_principal_name,
        COALESCE(a.modified_items, 0) AS modified_items,
        COALESCE(a.sites_touched, 0) AS sites_touched
      FROM filtered_users fu
      LEFT JOIN activity a ON a.user_id = fu.user_id
    )
  `;

  const [rows, totalRows, topByModifiedRows, topBySitesRows] = await Promise.all([
    query<any>(
      `
      ${usersDirectoryCte}
      SELECT *
      FROM filtered
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    query<any>(
      `
      ${usersDirectoryCte}
      SELECT COUNT(*)::int AS total
      FROM filtered
      `,
      params
    ),
    query<any>(
      `
      ${usersActivityCte}
      SELECT user_id, display_name, modified_items
      FROM filtered
      ORDER BY modified_items DESC NULLS LAST, display_name ASC NULLS LAST, user_id ASC
      LIMIT 10
      `,
      graphActivityParams
    ),
    query<any>(
      `
      ${usersActivityCte}
      SELECT user_id, display_name, sites_touched
      FROM filtered
      ORDER BY sites_touched DESC NULLS LAST, display_name ASC NULLS LAST, user_id ASC
      LIMIT 10
      `,
      graphActivityParams
    ),
  ]);

  const total = totalRows[0]?.total || 0;
  const topByModified = topByModifiedRows.map((u) => ({
    label: u.display_name ?? u.user_id,
    value: u.modified_items ?? 0,
  }));
  const topBySites = topBySitesRows.map((u) => ({
    label: u.display_name ?? u.user_id,
    value: u.sites_touched ?? 0,
  }));

  return (
    <main className="ps-page">
      <PageHeader
        title="Users"
        subtitle={`Directory-backed active users matching the overview dashboard metric. Activity charts use the ${windowDays == null ? "all-time" : `${windowDays}d`} window.`}
      />
      <form action="/dashboard/users" method="get">
        <FilterBar>
          <Input name="q" placeholder="Search users…" defaultValue={search || ""} className="w-64" />
          <select
            name="days"
            defaultValue={windowDays == null ? "all" : String(windowDays)}
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
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
            className="w-24"
            title="Page size"
          />
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </FilterBar>
      </form>

      <MetricGrid className="md:grid-cols-1 lg:grid-cols-1">
        <MetricCard label="Active Users" value={formatNumber(total)} className="max-w-sm" />
      </MetricGrid>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top 10 Users by Items Last Modified</CardTitle>
            <CardDescription>Activity window: {windowDays == null ? "All-time" : `${windowDays}d`}</CardDescription>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <UsersSummaryBarChartClient data={topByModified} label="Items last modified" xTitle="Count" />
            </div>
          </CardContent>
        </Card>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top 10 Users by Sites</CardTitle>
            <CardDescription>Activity window: {windowDays == null ? "All-time" : `${windowDays}d`}</CardDescription>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <UsersSummaryBarChartClient data={topBySites} label="Sites" xTitle="Count" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Users</CardTitle>
          <CardDescription>
            {formatNumber(total)} users • showing {formatNumber(rows.length)} • click a user for directory details and activity
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <UsersTable items={rows} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/users"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, pageSize, sort, dir, days: windowDays == null ? "all" : windowDays }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/users", UsersPage);
