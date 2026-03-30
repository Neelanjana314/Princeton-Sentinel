import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { formatNumber } from "@/app/lib/format";
import { getPagination, getParam, getSortDirection, SearchParams } from "@/app/lib/params";
import { SharingSummaryBarChartClient, SharingSummaryPieChartClient } from "@/components/sharing-summary-graphs-client";
import { SharingLinkBreakdownTable, SharingSitesTable } from "./sharing-tables";
import PageHeader from "@/components/page-header";
import FilterBar from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

function buildSearchFilter(search: string | null) {
  if (!search) return { clause: "", params: [] as any[] };
  return {
    clause:
      "WHERE (LOWER(i.title) LIKE $1 OR LOWER(i.web_url) LIKE $1 OR LOWER(i.site_id) LIKE $1 OR LOWER(i.route_drive_id) LIKE $1 OR LOWER(i.site_key) LIKE $1)",
    params: [`%${search.toLowerCase()}%`],
  };
}

export const dynamic = "force-dynamic";

async function SharingPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const search = getParam(resolvedSearchParams, "q");
  const { page, pageSize, offset } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const lbPage = Number(getParam(resolvedSearchParams, "lbPage") || 1);
  const lbPageSize = Number(getParam(resolvedSearchParams, "lbPageSize") || 10);
  const sort = getParam(resolvedSearchParams, "sort") || "links";
  const dir = getSortDirection(resolvedSearchParams, "desc");
  const externalThreshold = Number(getParam(resolvedSearchParams, "externalThreshold") || 10);

  const sortMap: Record<string, string> = {
    site: "i.title",
    links: "COALESCE(s.sharing_links, 0)",
    anonymous: "COALESCE(s.anonymous_links, 0)",
    guests: "COALESCE(e.guest_users, 0)",
    external: "COALESCE(e.external_users, 0)",
    lastShare: "s.last_shared_at",
  };
  const sortColumn = sortMap[sort] || "COALESCE(s.sharing_links, 0)";
  const { clause, params } = buildSearchFilter(search);
  const [breakdownAllRows, topSites, countRows, siteRows] = await Promise.all([
    query<any>(
      `
      SELECT link_scope, link_type, count
      FROM mv_msgraph_link_breakdown
      ORDER BY count DESC
      `
    ),
    query<any>(
      `
      SELECT i.site_key, i.title, COALESCE(s.sharing_links, 0) AS sharing_links
      FROM mv_msgraph_routable_site_drives i
      LEFT JOIN mv_msgraph_site_sharing_summary s ON s.site_key = i.site_key
      ORDER BY COALESCE(s.sharing_links, 0) DESC NULLS LAST
      LIMIT 10
      `
    ),
    query<any>("SELECT COUNT(*)::int AS total FROM mv_msgraph_routable_site_drives i " + clause, params),
    query<any>(
      `
      SELECT
        i.site_key,
        i.route_drive_id,
        i.title,
        i.web_url,
        i.is_personal,
        COALESCE(s.sharing_links, 0) AS sharing_links,
        COALESCE(s.anonymous_links, 0) AS anonymous_links,
        COALESCE(s.organization_links, 0) AS organization_links,
        s.last_shared_at,
        COALESCE(e.guest_users, 0) AS "distinctGuests",
        COALESCE(e.external_users, 0) AS "distinctExternalUsers"
      FROM mv_msgraph_routable_site_drives i
      LEFT JOIN mv_msgraph_site_sharing_summary s ON s.site_key = i.site_key
      LEFT JOIN mv_msgraph_site_external_principals e ON e.site_key = i.site_key
      ${clause}
      ORDER BY ${sortColumn} ${dir.toUpperCase()} NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
  ]);

  const lbOffset = (lbPage - 1) * lbPageSize;
  const breakdownRows = breakdownAllRows.slice(lbOffset, lbOffset + lbPageSize);
  const totalLinks = breakdownAllRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const lbTotal = breakdownAllRows.length;

  const total = countRows[0]?.total || 0;
  const totalSites = topSites.map((row: any) => ({ label: row.title || row.site_key, value: row.sharing_links || 0 }));
  const pieData = breakdownAllRows.map((row: any) => ({
    label: `${row.link_scope || "unknown"}:${row.link_type || "unknown"}`,
    value: row.count,
  }));

  const siteRowsEnriched = siteRows.map((row: any) => ({
    ...row,
    distinctGuests: Number(row.distinctGuests || 0),
    distinctExternalUsers: Number(row.distinctExternalUsers || 0),
  }));

  return (
    <main className="ps-page">
      <PageHeader title="Sharing" subtitle="Sharing links and external access signals." />
      <form action="/dashboard/sharing" method="get">
        <FilterBar>
          <Input name="q" placeholder="Search sites…" defaultValue={search || ""} className="w-64" />
          <Input
            name="externalThreshold"
            type="number"
            min={0}
            max={10000}
            defaultValue={String(externalThreshold)}
            className="w-28"
            title="Oversharing threshold"
          />
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

      <MetricGrid className="md:grid-cols-2 lg:grid-cols-2">
        <MetricCard label="Total Links" value={formatNumber(totalLinks)} />
        <MetricCard label="Sites Evaluated" value={formatNumber(total)} />
      </MetricGrid>

      <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top 10 Sites by Links</CardTitle>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <SharingSummaryBarChartClient data={totalSites} label="Links" xTitle="Links" />
            </div>
          </CardContent>
        </Card>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Link Scope+Type Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="w-full flex items-center justify-center">
            <div className="w-full h-72 flex items-center justify-center">
              <SharingSummaryPieChartClient data={pieData} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Link breakdown</CardTitle>
          <CardDescription>From permissions link scope and type.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SharingLinkBreakdownTable breakdown={breakdownRows} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/sharing"
        page={lbPage}
        pageSize={lbPageSize}
        totalItems={lbTotal}
        pageParam="lbPage"
        pageSizeParam="lbPageSize"
        extraParams={{ q: search || undefined, externalThreshold, page, pageSize, sort, dir }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Sites</CardTitle>
          <CardDescription>
            {formatNumber(total)} sites • showing {formatNumber(siteRowsEnriched.length)} • external threshold {externalThreshold}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SharingSitesTable sites={siteRowsEnriched} externalThreshold={externalThreshold} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/sharing"
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, externalThreshold, pageSize, sort, dir, lbPage, lbPageSize }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/sharing", SharingPage);
