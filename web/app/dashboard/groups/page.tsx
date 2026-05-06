import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getPagination, getParam, getSortDirection, SearchParams } from "@/app/lib/params";
import { GroupsTable } from "./groups-table";
import { GroupsSummaryBarChartClient, GroupsSummaryPieChartClient } from "@/components/groups-summary-graphs-wrapper";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, formatSearchFilterValue } from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

function buildSearchFilter(search: string | null) {
  if (!search) return { clause: "", params: [] as any[] };
  return {
    clause: "WHERE g.deleted_at IS NULL AND (LOWER(g.display_name) LIKE $1 OR LOWER(g.mail) LIKE $1 OR LOWER(g.id) LIKE $1)",
    params: [`%${search.toLowerCase()}%`],
  };
}

export const dynamic = "force-dynamic";

async function GroupsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "members";
  const dir = getSortDirection(resolvedSearchParams, "desc");

  const sortMap: Record<string, string> = {
    group: "g.display_name",
    visibility: "g.visibility",
    members: "member_count",
    created: "g.created_dt",
  };
  const sortColumn = sortMap[sort] || "member_count";

  const { clause, params } = buildSearchFilter(search);
  const whereClause = clause || "WHERE g.deleted_at IS NULL";
  const graphWhereClause = "WHERE g.deleted_at IS NULL";

  const [rows, countRows, topGroupRows, visibilityBreakdown] = await Promise.all([
    query<any>(
      `
      SELECT
        g.id AS group_id,
        g.display_name,
        g.mail,
        g.visibility,
        g.created_dt,
        COALESCE(mc.member_count, 0) AS member_count
      FROM msgraph_groups g
      LEFT JOIN mv_msgraph_group_member_counts mc ON mc.group_id = g.id
      ${whereClause}
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    query<any>(
      `SELECT COUNT(*)::int AS total FROM msgraph_groups g ${whereClause}`,
      params
    ),
    query<any>(
      `
      SELECT
        g.id AS group_id,
        g.display_name,
        COALESCE(mc.member_count, 0) AS member_count
      FROM msgraph_groups g
      LEFT JOIN mv_msgraph_group_member_counts mc ON mc.group_id = g.id
      ${graphWhereClause}
      ORDER BY member_count DESC NULLS LAST, g.display_name ASC NULLS LAST, g.id ASC
      LIMIT 10
      `,
      []
    ),
    query<any>(
      `
      SELECT COALESCE(g.visibility, 'unknown') AS visibility, COUNT(*)::int AS count
      FROM msgraph_groups g
      ${graphWhereClause}
      GROUP BY COALESCE(g.visibility, 'unknown')
      ORDER BY count DESC
      `,
      []
    ),
  ]);
  const total = countRows[0]?.total || 0;

  const topGroups = topGroupRows.map((g) => ({
    label: g.display_name ?? g.group_id,
    value: g.member_count ?? 0,
  }));
  const visibilityData = visibilityBreakdown.map((row: any) => ({ label: row.visibility, value: row.count }));

  return (
    <main className="ps-page">
      <PageHeader title="Groups" subtitle="Microsoft 365 groups and membership counts from the ingest." />

      <form action="/dashboard/groups" method="get">
        <FilterBar>
          <FilterField label="Search">
            <Input name="q" placeholder="Search groups…" defaultValue={search || ""} className="w-64" />
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
              { label: "Page size", value: pageSize },
            ]}
          />
        </FilterBar>
      </form>

      <MetricGrid className="md:grid-cols-1 lg:grid-cols-1">
        <MetricCard label="Total Groups" value={formatNumber(total)} className="max-w-sm" />
      </MetricGrid>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top 10 Groups by Members</CardTitle>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <GroupsSummaryBarChartClient data={topGroups} />
            </div>
          </CardContent>
        </Card>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Visibility Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <GroupsSummaryPieChartClient data={visibilityData} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
          <CardDescription>
            {formatNumber(total)} groups • showing {formatNumber(rows.length)}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <GroupsTable items={rows} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/groups"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, pageSize, sort, dir }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/groups", GroupsPage);
