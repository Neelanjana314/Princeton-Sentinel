import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardTotalsBarChartClient } from "@/components/dashboard-totals-bar-chart-client";
import { SharingSummaryBarChartClient, SharingSummaryPieChartClient } from "@/components/sharing-summary-graphs-client";
import { formatBytes } from "@/app/lib/format";
import { query } from "@/app/lib/db";
import { requireUser } from "@/app/lib/auth";
import PageHeader from "@/components/page-header";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";
import { InfoTooltip } from "@/components/info-tooltip";

export const dynamic = "force-dynamic";

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
      return "Group/Sharepoint Drives";
    case "cacheLibrary":
      return "Cache Library";
    default:
      return driveType ?? "Unknown";
  }
}

async function DashboardPage() {
  await requireUser();

  const [inventoryRows, linkBreakdownRows, driveTotalsRows, driveTypeRows, topStorageRows] = await Promise.all([
    query<any>("SELECT * FROM mv_msgraph_inventory_summary LIMIT 1"),
    query<any>("SELECT link_scope, link_type, count FROM mv_msgraph_link_breakdown"),
    query<any>("SELECT * FROM mv_msgraph_drive_storage_totals LIMIT 1"),
    query<any>("SELECT drive_type, count FROM mv_msgraph_drive_type_counts ORDER BY count DESC"),
    query<any>("SELECT label, quota_used FROM mv_msgraph_storage_by_owner_site ORDER BY rank ASC"),
  ]);

  const inventory = inventoryRows[0] || {};
  const driveTotals = driveTotalsRows[0] || {};

  const chartTotals = {
    sites: Number(inventory.sharepoint_sites_total || 0),
    users: Number(inventory.active_users_total || 0),
    groups: Number(inventory.groups_total || 0),
    drives: Number(inventory.drives_total_excluding_personal_cache_library || 0),
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
  }));

  const toFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const topStorage = topStorageRows
    .map((d: any) => {
      const quotaUsed = toFiniteNumber(d.quota_used);
      return quotaUsed === null
        ? null
        : {
            label: d.label ?? "Unknown",
            value: quotaUsed / 1024 / 1024 / 1024,
          };
    })
    .filter((d): d is { label: string; value: number } => d !== null)
    .slice(0, 10);

  return (
    <main className="ps-page">
      <PageHeader
        title="Dashboard"
        subtitle="High-level posture signals from directory, storage, and sharing metadata."
      />

      <MetricGrid>
        <MetricCard label="Sharepoint Sites" value={chartTotals.sites.toLocaleString()} />
        <MetricCard label="Active Users" value={chartTotals.users.toLocaleString()} />
        <MetricCard label="Groups" value={chartTotals.groups.toLocaleString()} />
        <MetricCard label="Drives" value={chartTotals.drives.toLocaleString()} />
      </MetricGrid>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Directory totals</CardTitle>
            <CardDescription>Sharepoint sites, active users, groups, drives</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <DashboardTotalsBarChartClient totals={chartTotals} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Sharing link scopes</span>
              <InfoTooltip label="Shows link-based shares only. Anyone with the link means anonymous access, People in your org means organization-wide access, and Specific people means named recipients. Direct permissions without a link are not included." />
            </CardTitle>
            <CardDescription>Current link-based sharing by who the link can be used by</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <SharingSummaryPieChartClient data={linkScopePie} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Drive types</CardTitle>
            <CardDescription>Where content lives across user and SharePoint-connected storage</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <SharingSummaryPieChartClient data={driveTypePie} />
          </CardContent>
        </Card>

        <Card>
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
