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
import { buildHref } from "@/lib/pagination";
import { UsersSummaryBarChartClient } from "@/components/users-summary-graphs-wrapper";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, ResetFiltersButton, formatSearchFilterValue } from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";
import {
  buildUserStatusPredicate,
  getUserStatusLabel,
  getUserStatusSubtitle,
  normalizeUserStatus,
  type UserStatusFilter,
} from "./status-filter";

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

function getUserStatusSelectLabel(status: UserStatusFilter) {
  switch (status) {
    case "inactive":
      return "inactive users";
    case "all":
      return "all users";
    case "active":
    default:
      return "active users";
  }
}

function formatUserStatusFilter(status: UserStatusFilter) {
  if (status === "inactive") return "Inactive";
  if (status === "all") return "All";
  return "Active";
}

function formatWindowFilter(days: number | null) {
  return days == null ? "All-time" : `${days}d`;
}

async function UsersPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const status = normalizeUserStatus(getParam(resolvedSearchParams, "status"));
  const statusLabel = getUserStatusLabel(status);
  const statusSubtitle = getUserStatusSubtitle(status);
  const statusSelectLabel = getUserStatusSelectLabel(status);
  const windowDays = getParam(resolvedSearchParams, "days") ? getWindowDays(resolvedSearchParams, 90) : null;
  const windowStart = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "user";
  const dir = getSortDirection(resolvedSearchParams, "asc");
  const statusClause = buildUserStatusPredicate(status);

  const sortMap: Record<string, string> = {
    user: "COALESCE(display_name, mail, user_principal_name, user_id)",
    email: "COALESCE(mail, user_principal_name, '')",
    type: "user_type",
    department: "department",
    title: "job_title",
    created: "created_dt",
    synced: "created_dt",
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
        u.created_dt
      FROM msgraph_users u
      WHERE 1=1
        ${statusClause}
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
        ${statusClause}
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
  const usersSummaryCte = `
    WITH filtered AS (
      SELECT u.account_enabled
      FROM msgraph_users u
      WHERE 1=1
        AND u.deleted_at IS NULL
        ${searchClause.clause}
    )
  `;

  const [rows, totalRows, summaryRows, topByModifiedRows, topBySitesRows, dataRefreshFinishedAt] = await Promise.all([
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
      ${usersSummaryCte}
      SELECT
        COUNT(*) FILTER (WHERE account_enabled IS TRUE)::int AS active_total,
        COUNT(*) FILTER (WHERE account_enabled IS NOT TRUE)::int AS inactive_total,
        COUNT(*)::int AS all_total
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
    getLatestDataRefreshFinishedAt("graph_ingest"),
  ]);

  const total = totalRows[0]?.total || 0;
  const summary = summaryRows[0] || {};
  const statusMetrics = [
    {
      status: "active" as const,
      label: "Active Users",
      value: Number(summary.active_total || 0),
    },
    {
      status: "inactive" as const,
      label: "Inactive Users",
      value: Number(summary.inactive_total || 0),
    },
    {
      status: "all" as const,
      label: "All Users",
      value: Number(summary.all_total || 0),
    },
  ];
  const metricBaseParams = {
    q: search || undefined,
    days: windowDays == null ? "all" : String(windowDays),
    pageSize,
    sort,
    dir,
  };
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
        subtitle={`${statusSubtitle} Activity charts use the ${windowDays == null ? "all-time" : `${windowDays}d`} window.`}
        actions={<DataRefreshTimestamp sourceLabel="Tenant data sync" finishedAt={dataRefreshFinishedAt} />}
      />
      <form action="/dashboard/users" method="get">
        <FilterBar>
          <FilterField label="Search">
            <Input name="q" placeholder="Search users…" defaultValue={search || ""} className="w-64" />
          </FilterField>
          <FilterField label="User status">
            <select
              name="status"
              defaultValue={status}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
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
          <ResetFiltersButton href="/dashboard/users" />
          <AppliedFilterTags
            tags={[
              { label: "Search", value: formatSearchFilterValue(search) },
              { label: "User status", value: formatUserStatusFilter(status) },
              { label: "Activity window", value: formatWindowFilter(windowDays) },
              { label: "Page size", value: pageSize },
            ]}
          />
        </FilterBar>
      </form>

      <MetricGrid className="md:grid-cols-2 xl:grid-cols-3">
        {statusMetrics.map((metric) => (
          <MetricCard
            key={metric.status}
            label={metric.label}
            value={formatNumber(metric.value)}
            detail={metric.status === status ? "Current filter" : undefined}
            href={
              metric.status === status
                ? undefined
                : buildHref("/dashboard/users", {
                    ...metricBaseParams,
                    status: metric.status,
                  })
            }
          />
        ))}
      </MetricGrid>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top 10 Users by Items Last Modified</CardTitle>
            <CardDescription>
              Showing {statusSelectLabel} • activity window: {windowDays == null ? "All-time" : `${windowDays}d`}
            </CardDescription>
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
            <CardDescription>
              Showing {statusSelectLabel} • activity window: {windowDays == null ? "All-time" : `${windowDays}d`}
            </CardDescription>
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
          <CardTitle>{statusLabel} Users</CardTitle>
          <CardDescription>
            {formatNumber(total)} {statusSelectLabel} • showing {formatNumber(rows.length)} • click a user for directory details and activity
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <UsersTable items={rows} emptyMessage={`No ${statusSelectLabel} matched your search.`} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/users"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, pageSize, sort, dir, status, days: windowDays == null ? "all" : windowDays }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/users", UsersPage);
