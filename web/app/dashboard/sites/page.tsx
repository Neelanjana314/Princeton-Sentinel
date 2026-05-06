import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getPagination, getParam, getSortDirection, SearchParams } from "@/app/lib/params";
import { SitesTable } from "./sites-table";
import { SitesSummaryGraph } from "@/components/sites-summary-graph";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, formatSearchFilterValue } from "@/components/filter-bar";

const DASHBOARD_SHAREPOINT_FILTER = `
  is_dashboard_sharepoint = true
`;

function buildSearchFilter(search: string | null) {
  if (!search) return { clause: "", params: [] as any[] };
  return {
    clause:
      "WHERE (LOWER(title) LIKE $1 OR LOWER(web_url) LIKE $1 OR LOWER(site_id) LIKE $1 OR LOWER(site_key) LIKE $1 OR LOWER(route_drive_id) LIKE $1)",
    params: [`%${search.toLowerCase()}%`],
  };
}

export const dynamic = "force-dynamic";

async function SitesPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const sort = getParam(resolvedSearchParams, "sort") || "lastActivity";
  const dir = getSortDirection(resolvedSearchParams, "desc");

  const sortMap: Record<string, string> = {
    title: "title",
    created: "created_dt",
    storage: "storage_used_bytes",
    lastActivity: "last_activity_dt",
  };
  const sortColumn = sortMap[sort] || "last_activity_dt";
  const { clause, params } = buildSearchFilter(search);
  const [countRows, summaryRows, createdSeries, recencyRows, rows] = await Promise.all([
    query<any>(
      `
      SELECT COUNT(*)::int AS total
      FROM mv_msgraph_routable_site_drives
      WHERE ${DASHBOARD_SHAREPOINT_FILTER}
      ${clause ? `AND ${clause.replace(/^WHERE\s+/i, "")}` : ""}
      `,
      params
    ),
    query<any>(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_dt >= now() - interval '30 days')::int AS new_30,
        COUNT(*) FILTER (WHERE created_dt >= now() - interval '90 days')::int AS new_90
      FROM mv_msgraph_routable_site_drives
      WHERE ${DASHBOARD_SHAREPOINT_FILTER}
      `,
      []
    ),
    query<any>(
      `
      SELECT date_trunc('month', created_dt) AS month, COUNT(*)::int AS count
      FROM mv_msgraph_routable_site_drives
      WHERE created_dt IS NOT NULL
        AND ${DASHBOARD_SHAREPOINT_FILTER}
      GROUP BY date_trunc('month', created_dt)
      ORDER BY month DESC
      LIMIT 12
      `,
      []
    ),
    query<any>(
      `
      SELECT
        COUNT(*) FILTER (WHERE last_activity_dt >= now() - interval '30 days')::int AS active_30,
        COUNT(*) FILTER (
          WHERE last_activity_dt < now() - interval '30 days'
            AND last_activity_dt >= now() - interval '90 days'
        )::int AS active_31_90,
        COUNT(*) FILTER (
          WHERE last_activity_dt < now() - interval '90 days'
            AND last_activity_dt >= now() - interval '180 days'
        )::int AS active_91_180,
        COUNT(*) FILTER (WHERE last_activity_dt < now() - interval '180 days')::int AS active_180_plus,
        COUNT(*) FILTER (WHERE last_activity_dt IS NULL)::int AS no_activity
      FROM mv_msgraph_routable_site_drives
      WHERE ${DASHBOARD_SHAREPOINT_FILTER}
      `,
      []
    ),
    query<any>(
      `
      SELECT site_key, site_id, route_drive_id, title, web_url, created_dt,
             storage_used_bytes, storage_total_bytes, last_activity_dt
      FROM mv_msgraph_routable_site_drives
      WHERE ${DASHBOARD_SHAREPOINT_FILTER}
      ${clause ? `AND ${clause.replace(/^WHERE\s+/i, "")}` : ""}
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
  ]);
  const total = countRows[0]?.total || 0;

  const summary = summaryRows[0] || {};
  const recency = recencyRows[0] || {};

  return (
    <main className="ps-page">
      <PageHeader title="SharePoint Sites" subtitle="Inventory for the same SharePoint site population shown on the dashboard overview." />

      <form action="/dashboard/sites" method="get">
        <FilterBar>
          <FilterField label="Search">
            <Input name="q" placeholder="Search title, URL, or id…" defaultValue={search || ""} className="w-72" />
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(total)}</CardTitle>
            <CardDescription>Total SharePoint Sites</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(summary.new_30 || 0)}</CardTitle>
            <CardDescription>New (30 days)</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{formatNumber(summary.new_90 || 0)}</CardTitle>
            <CardDescription>New (90 days)</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <SitesSummaryGraph
        createdByMonth={createdSeries.map((p: any) => ({
          label: p.month ? new Date(p.month).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : "--",
          value: p.count,
        }))}
        activityRecencyBuckets={[
          { label: "0-30d", value: Number(recency.active_30 || 0) },
          { label: "31-90d", value: Number(recency.active_31_90 || 0) },
          { label: "91-180d", value: Number(recency.active_91_180 || 0) },
          { label: "180d+", value: Number(recency.active_180_plus || 0) },
          { label: "No activity", value: Number(recency.no_activity || 0) },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Inventory</CardTitle>
          <CardDescription>
            {formatNumber(total)} SharePoint sites • showing {formatNumber(rows.length)}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SitesTable items={rows} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/sites"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, sort, dir }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/sites", SitesPage);
