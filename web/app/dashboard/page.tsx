import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardTotalsBarChartClient } from "@/components/dashboard-totals-bar-chart-client";
import { SharingSummaryBarChartClient, SharingSummaryPieChartClient } from "@/components/sharing-summary-graphs-client";
import { formatBytes } from "@/app/lib/format";
import { query } from "@/app/lib/db";
import { requireUser } from "@/app/lib/auth";
import PageHeader from "@/components/page-header";
import { InfoTooltip } from "@/components/info-tooltip";
import { cn } from "@/lib/utils";
import { DashboardOverviewMetrics } from "@/components/dashboard-overview-metrics";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";

export const dynamic = "force-dynamic";

function OverviewLinkedCard({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </Link>
  );
}

function labelLinkScope(scope: string | null | undefined) {
  switch (scope) {
    case "anonymous":
      return "Anyone with the link";
    case "organization":
      return "People in your org";
    case "users":
      return "Specific people";
    default:
      return "Unknown scope";
  }
}

function labelDriveType(driveType: string | null | undefined) {
  switch (driveType) {
    case "business":
      return "User Drives";
    case "documentLibrary":
      return "Group/SharePoint Drives";
    case "cacheLibrary":
      return "Cache Library";
    default:
      return driveType ?? "Unknown";
  }
}

function driveTypeHref(driveType: string | null | undefined) {
  switch (driveType) {
    case "business":
      return "/dashboard/activity?siteType=personal";
    case "documentLibrary":
      return "/dashboard/activity?siteType=nonPersonal";
    default:
      return "/dashboard/activity";
  }
}

async function DashboardPage() {
  await requireUser();

  const [inventoryRows, activitySiteCountRows, linkBreakdownRows, driveTotalsRows, driveTypeRows, topStorageRows, dataRefreshFinishedAt] = await Promise.all([
    query<any>("SELECT * FROM mv_msgraph_inventory_summary LIMIT 1"),
    query<any>("SELECT COUNT(*)::int AS total FROM mv_msgraph_routable_site_drives"),
    query<any>("SELECT link_scope, link_type, count FROM mv_msgraph_link_breakdown"),
    query<any>("SELECT * FROM mv_msgraph_drive_storage_totals LIMIT 1"),
    query<any>("SELECT drive_type, count FROM mv_msgraph_drive_type_counts ORDER BY count DESC"),
    query<any>(
      `
      WITH labeled_drives AS (
        SELECT
          COALESCE(
            NULLIF(trim(s.name), ''),
            NULLIF(trim(g.display_name), ''),
            NULLIF(trim(u.display_name), ''),
            NULLIF(trim(d.owner_display_name), ''),
            NULLIF(trim(d.owner_email), ''),
            NULLIF(trim(d.name), ''),
            d.id
          ) AS label,
          COALESCE(d.quota_used, 0) AS quota_used,
          CASE
            WHEN d.site_id IS NULL THEN d.id
            ELSE rsd.route_drive_id
          END AS route_drive_id
        FROM msgraph_drives d
        LEFT JOIN msgraph_users u ON u.id = d.owner_id AND u.deleted_at IS NULL
        LEFT JOIN msgraph_sites s ON s.id = d.site_id AND s.deleted_at IS NULL
        LEFT JOIN msgraph_groups g ON g.id = d.owner_id AND g.deleted_at IS NULL
        LEFT JOIN mv_msgraph_routable_site_drives rsd ON rsd.site_id = d.site_id
        WHERE d.deleted_at IS NULL
          AND COALESCE(d.name, '') <> 'PersonalCacheLibrary'
      ),
      aggregated AS (
        SELECT
          label,
          SUM(quota_used)::bigint AS quota_used,
          (ARRAY_AGG(route_drive_id ORDER BY quota_used DESC NULLS LAST, route_drive_id ASC))[1] AS route_drive_id
        FROM labeled_drives
        GROUP BY label
      )
      SELECT label, quota_used, route_drive_id
      FROM aggregated
      ORDER BY quota_used DESC NULLS LAST, label ASC
      LIMIT 10
      `
    ),
    getLatestDataRefreshFinishedAt("graph_ingest"),
  ]);

  const inventory = inventoryRows[0] || {};
  const activitySiteCount = Number(activitySiteCountRows[0]?.total || 0);
  const driveTotals = driveTotalsRows[0] || {};

  const chartTotals = {
    sites: Number(inventory.sharepoint_sites_total || 0),
    users: Number(inventory.active_users_total || 0),
    groups: Math.max(0, Number(inventory.groups_total || 0) - Number(inventory.groups_deleted || 0)),
    drives: activitySiteCount,
  };

  const linkScopeCounts = new Map<string, number>();
  for (const r of linkBreakdownRows) {
    const scope = r.link_scope ?? "unknown";
    linkScopeCounts.set(scope, (linkScopeCounts.get(scope) ?? 0) + Number(r.count ?? 0));
  }
  const linkScopePie = Array.from(linkScopeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([scope, value]) => ({ label: labelLinkScope(scope), value }));

  const driveTypePie = driveTypeRows.map((r: any) => ({
    label: labelDriveType(r.drive_type),
    value: Number(r.count ?? 0),
    href: driveTypeHref(r.drive_type),
  }));

  const toFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const topStorage: { label: string; value: number; href?: string }[] = topStorageRows
    .map((d: any) => {
      const quotaUsed = toFiniteNumber(d.quota_used);
      return quotaUsed === null
        ? null
        : {
            label: d.label ?? "Unknown",
            value: quotaUsed / 1024 / 1024 / 1024,
            href: d.route_drive_id ? `/sites/${encodeURIComponent(d.route_drive_id)}` : undefined,
          };
    })
    .filter((d) => d !== null)
    .slice(0, 10);

  return (
    <main className="ps-page">
      <PageHeader
        title="Dashboard"
        subtitle="High-level posture signals from directory, storage, and sharing metadata."
        actions={<DataRefreshTimestamp sourceLabel="Graph sync" finishedAt={dataRefreshFinishedAt} />}
      />

      <DashboardOverviewMetrics totals={chartTotals} />

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Directory totals</CardTitle>
            <CardDescription>SharePoint sites, active users, groups, drives</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <DashboardTotalsBarChartClient totals={chartTotals} />
          </CardContent>
        </Card>

        <OverviewLinkedCard href="/dashboard/sharing">
          <Card className={cn("h-full cursor-pointer transition-shadow hover:shadow-md")}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>Sharing link scopes</span>
                <InfoTooltip label="Shows link-based shares only. Anyone with the link means anonymous access, People in your org means organization-wide access, and Specific people means named recipients. Direct permissions without a link are not included." />
              </CardTitle>
              <CardDescription>Current link-based sharing by who the link can be used by</CardDescription>
            </CardHeader>
            <CardContent className="h-72">
              <SharingSummaryPieChartClient data={linkScopePie} href="/dashboard/sharing" />
            </CardContent>
          </Card>
        </OverviewLinkedCard>

        <Card className={cn("h-full")}>
          <CardHeader>
            <CardTitle>Drive types</CardTitle>
            <CardDescription>Where content lives across user and SharePoint-connected storage</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <SharingSummaryPieChartClient data={driveTypePie} href="/dashboard/activity" />
          </CardContent>
        </Card>

        <Card className={cn("h-full")}>
          <CardHeader>
            <CardTitle>Storage usage by owner/site</CardTitle>
            <CardDescription>Total Size {formatBytes(driveTotals.storage_used)}</CardDescription>
          </CardHeader>
          <CardContent className="h-72 flex items-center">
            <SharingSummaryBarChartClient data={topStorage} label="Used (GB)" xTitle="GB" />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export default withPageRequestTiming("/dashboard", DashboardPage);
