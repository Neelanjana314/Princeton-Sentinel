import { withPageRequestTiming } from "@/app/lib/request-timing";
import type React from "react";
import { query } from "@/app/lib/db";
import { requireUser } from "@/app/lib/auth";
import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";
import { formatNumber } from "@/app/lib/format";
import { getParam, type SearchParams } from "@/app/lib/params";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, ResetFiltersButton } from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";
import LocalDateTime from "@/components/local-date-time";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  M365CopilotAppPieChartClient,
  M365CopilotAppTimeChartClient,
  M365CopilotTimeOfDayChartClient,
  M365CopilotTrendChartClient,
} from "@/components/m365-copilot-charts-client";

export const dynamic = "force-dynamic";

const PERIODS = [
  { value: "D7", label: "7 days" },
  { value: "D30", label: "30 days" },
  { value: "D90", label: "90 days" },
  { value: "D180", label: "180 days" },
  { value: "ALL", label: "All" },
] as const;

function normalizePeriod(value: string | null | undefined) {
  return PERIODS.some((period) => period.value === value) ? value! : "D30";
}

function periodDays(value: string) {
  if (value === "ALL") return null;
  const days = Number(value.replace(/^D/, ""));
  return Number.isFinite(days) ? days : 30;
}

function toIso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function formatAppLabel(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  const parts = text.split(".").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || text;
}

async function CopilotPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();
  await redirectIfFeatureDisabled("copilot_dashboard");

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const selectedPeriod = normalizePeriod(getParam(resolvedSearchParams, "period"));
  const currentRange = PERIODS.find((period) => period.value === selectedPeriod) ?? PERIODS[1];
  const selectedPeriodDays = periodDays(selectedPeriod);

  const [
    summaryRows,
    trendRows,
    promptSummaryRows,
    appRows,
    hourlyRows,
    appHourlyRows,
    topUserRows,
    departmentRows,
    dataRefreshFinishedAt,
  ] = await Promise.all([
    query<any>(
      `
      SELECT source_period, report_refresh_date, report_period, enabled_users, active_users
      FROM m365_copilot_user_count_summary
      WHERE source_period = $1
      LIMIT 1
      `,
      [selectedPeriod]
    ),
    query<any>(
      `
      SELECT report_date, enabled_users, active_users
      FROM m365_copilot_user_count_trend
      WHERE source_period = $1
      ORDER BY report_date ASC
      `,
      [selectedPeriod]
    ),
    query<any>(
      `
      SELECT
        COALESCE(SUM(prompt_count), 0)::int AS prompts,
        COUNT(DISTINCT entra_user_id)::int AS users_with_prompts,
        MAX(bucket_start_utc) AS latest_prompt_at
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      `,
      [selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT source_app, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      GROUP BY source_app
      ORDER BY prompts DESC, source_app ASC
      LIMIT 12
      `,
      [selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT date_trunc('hour', bucket_start_utc) AS bucket, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT date_trunc('day', bucket_start_utc) AS bucket, source_app, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      GROUP BY 1, 2
      ORDER BY 1 ASC, prompts DESC
      `,
      [selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT
        entra_user_id,
        COALESCE(NULLIF(display_name, ''), NULLIF(user_principal_name, ''), entra_user_id) AS user_label,
        user_principal_name,
        department,
        office_location,
        SUM(prompt_count)::int AS prompts,
        COUNT(DISTINCT source_app)::int AS apps_used,
        MAX(bucket_start_utc) AS latest_prompt_at
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      GROUP BY entra_user_id, user_label, user_principal_name, department, office_location
      ORDER BY prompts DESC, user_label ASC
      LIMIT 10
      `,
      [selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT COALESCE(NULLIF(department, ''), 'Unknown') AS label, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE ($1::int IS NULL OR bucket_start_utc >= now() - ($1::int * interval '1 day'))
      GROUP BY 1
      ORDER BY prompts DESC, label ASC
      LIMIT 8
      `,
      [selectedPeriodDays]
    ),
    getLatestDataRefreshFinishedAt("copilot_usage_sync"),
  ]);

  const summary = summaryRows[0] || {};
  const promptSummary = promptSummaryRows[0] || {};
  const enabledUsers = Number(summary.enabled_users || 0);
  const activeUsers = Number(summary.active_users || 0);
  const adoptionRate = enabledUsers > 0 ? `${Math.round((activeUsers / enabledUsers) * 1000) / 10}%` : "--";
  const promptCount = Number(promptSummary.prompts || 0);
  const usersWithPrompts = Number(promptSummary.users_with_prompts || 0);

  const trendData = trendRows.map((row: any) => ({
    date: toIso(row.report_date),
    activeUsers: Number(row.active_users || 0),
    enabledUsers: Number(row.enabled_users || 0),
  }));
  const appData = appRows.map((row: any) => ({
    label: row.source_app || "Unknown",
    value: Number(row.prompts || 0),
  }));
  const appRatioMap = new Map<string, number>();
  for (const row of appData) {
    const label = formatAppLabel(row.label);
    appRatioMap.set(label, (appRatioMap.get(label) || 0) + row.value);
  }
  const appRatioData = Array.from(appRatioMap.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const hourlyData = hourlyRows.map((row: any) => ({
    bucket: toIso(row.bucket),
    prompts: Number(row.prompts || 0),
  }));

  const topApps = appRatioData.slice(0, 6).map((row) => row.label);
  const bucketMap = new Map<string, Record<string, number>>();
  for (const row of appHourlyRows) {
    const bucket = toIso(row.bucket);
    const appLabel = formatAppLabel(row.source_app);
    const app = topApps.includes(appLabel) ? appLabel : "Other";
    const values = bucketMap.get(bucket) ?? {};
    values[app] = (values[app] ?? 0) + Number(row.prompts || 0);
    bucketMap.set(bucket, values);
  }
  const appTimeBuckets = Array.from(bucketMap.entries()).map(([bucket, values]) => ({ bucket, values }));
  const appTimeApps = Array.from(new Set([...topApps, ...appTimeBuckets.flatMap((bucket) => Object.keys(bucket.values))])).slice(0, 7);

  return (
    <main className="ps-page">
      <PageHeader
        title="Copilot Utilization"
        subtitle={`Microsoft 365 Copilot usage from Graph reports. Selected report period: ${currentRange.label}.`}
        actions={<DataRefreshTimestamp sourceLabel="Copilot usage sync" finishedAt={dataRefreshFinishedAt} />}
      />

      <form action="/dashboard/copilot" method="get">
        <FilterBar>
          <FilterField label="Report period">
            <select
              name="period"
              defaultValue={selectedPeriod}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              {PERIODS.map((period) => (
                <option key={period.value} value={period.value}>
                  {period.label}
                </option>
              ))}
            </select>
          </FilterField>
          <Button type="submit" variant="outline" className="self-end">
            Apply
          </Button>
          <ResetFiltersButton href="/dashboard/copilot" />
          <AppliedFilterTags tags={[{ label: "Report period", value: currentRange.label }]} />
        </FilterBar>
      </form>

      <MetricGrid>
        <MetricCard
          label="Enabled Users"
          value={formatNumber(enabledUsers)}
          detail={
            summary.report_refresh_date ? (
              <>
                Graph report refreshed{" "}
                <LocalDateTime
                  value={String(summary.report_refresh_date)}
                  dateOnly
                  options={{ month: "short", day: "numeric", year: "numeric" }}
                />
              </>
            ) : (
              "No report data yet"
            )
          }
          info="Sourced from Microsoft Graph getMicrosoft365CopilotUserCountSummary reportRefreshDate. This is the report data refresh date from Microsoft, not the dashboard render date."
        />
        <MetricCard label="Active Users" value={formatNumber(activeUsers)} detail={`${currentRange.label} report period`} />
        <MetricCard label="Adoption" value={adoptionRate} detail="Active / enabled users" />
        <MetricCard label="User Prompts" value={formatNumber(promptCount)} detail={`${currentRange.label}; ${formatNumber(usersWithPrompts)} users with prompts`} />
      </MetricGrid>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Active user trend</CardTitle>
            <CardDescription>Enabled and active users from Microsoft 365 Copilot report data</CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            {trendData.length ? <M365CopilotTrendChartClient data={trendData} /> : <EmptyState label="No trend data yet." />}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Application ratio</CardTitle>
            <CardDescription>{currentRange.label} user prompts by source app</CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            {appRatioData.length ? <M365CopilotAppPieChartClient data={appRatioData} /> : <EmptyState label="No interaction data yet." />}
          </CardContent>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Time of day</CardTitle>
            <CardDescription>{currentRange.label} prompts grouped into local-time parts of day.</CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            {hourlyData.length ? <M365CopilotTimeOfDayChartClient data={hourlyData} /> : <EmptyState label="No prompt buckets yet." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>App activity over time</CardTitle>
            <CardDescription>{currentRange.label} daily prompts stacked by source app</CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            {appTimeBuckets.length ? <M365CopilotAppTimeChartClient buckets={appTimeBuckets} apps={appTimeApps} /> : <EmptyState label="No app activity yet." />}
          </CardContent>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top users</CardTitle>
            <CardDescription>{currentRange.label} prompt volume by user</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleTable
              rows={topUserRows}
              emptyLabel="No user interaction aggregates yet."
              columns={[
                ["User", (row) => row.user_label || "Unknown"],
                ["Department", (row) => row.department || "Unknown"],
                ["Apps", (row) => formatNumber(row.apps_used)],
                ["Prompts", (row) => formatNumber(row.prompts)],
                [
                  "Latest",
                  (row) => (
                    <LocalDateTime
                      value={toIso(row.latest_prompt_at)}
                      options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }}
                    />
                  ),
                ],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top departments</CardTitle>
            <CardDescription>{currentRange.label} prompt volume by department</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleTable
              rows={departmentRows}
              emptyLabel="No department aggregates yet."
              columns={[
                ["Department", (row) => row.label || "Unknown"],
                ["Prompts", (row) => formatNumber(row.prompts)],
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{label}</div>;
}

function SimpleTable({
  rows,
  columns,
  emptyLabel,
}: {
  rows: any[];
  emptyLabel: string;
  columns: [string, (row: any) => React.ReactNode][];
}) {
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="ps-table">
        <thead className="text-left text-slate/70">
          <tr>
            {columns.map(([label]) => (
              <th key={label} className="py-2 pr-4">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.entra_user_id || row.user_principal_name || row.label || index} className="border-t">
              {columns.map(([label, render]) => (
                <td key={label} className="py-2 pr-4 text-sm">
                  {render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default withPageRequestTiming("/dashboard/copilot", CopilotPage);
