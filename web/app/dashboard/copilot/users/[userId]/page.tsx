import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import type React from "react";
import { notFound } from "next/navigation";

import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";
import { formatNumber, safeDecode } from "@/app/lib/format";
import { getParam, type SearchParams } from "@/app/lib/params";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";
import FilterBar, { AppliedFilterTags, FilterField, ResetFiltersButton } from "@/components/filter-bar";
import LocalDateTime from "@/components/local-date-time";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";
import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  M365CopilotAppPieChartClient,
  M365CopilotAppTimeChartClient,
  M365CopilotTimeOfDayChartClient,
} from "@/components/m365-copilot-charts-client";

import { PERIODS, formatAppLabel, normalizePeriod, periodDays, toIso } from "../../copilot-utils";

export const dynamic = "force-dynamic";

async function CopilotUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  await requireUser();
  await redirectIfFeatureDisabled("copilot_dashboard");

  const { userId: encodedUserId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const userId = safeDecode(encodedUserId);
  const selectedPeriod = normalizePeriod(getParam(resolvedSearchParams, "period"));
  const currentRange = PERIODS.find((period) => period.value === selectedPeriod) ?? PERIODS[1];
  const selectedPeriodDays = periodDays(selectedPeriod);

  const [
    profileRows,
    summaryRows,
    appRows,
    hourlyRows,
    appHourlyRows,
    conversationRows,
    contextRows,
    dataRefreshFinishedAt,
  ] = await Promise.all([
    query<any>(
      `
      SELECT
        entra_user_id,
        COALESCE(
          MAX(NULLIF(display_name, '')),
          MAX(NULLIF(user_principal_name, '')),
          entra_user_id
        ) AS user_label,
        MAX(NULLIF(user_principal_name, '')) AS user_principal_name,
        MAX(NULLIF(department, '')) AS department,
        MAX(NULLIF(office_location, '')) AS office_location
      FROM (
        SELECT entra_user_id, display_name, user_principal_name, department, office_location
        FROM m365_copilot_interaction_aggregates
        WHERE entra_user_id = $1
        UNION ALL
        SELECT entra_user_id, display_name, user_principal_name, department, office_location
        FROM m365_copilot_usage_user_detail
        WHERE entra_user_id = $1
      ) profile
      GROUP BY entra_user_id
      LIMIT 1
      `,
      [userId]
    ),
    query<any>(
      `
      SELECT
        COALESCE(SUM(prompt_count), 0)::int AS prompts,
        COALESCE(SUM(request_count), 0)::int AS requests,
        COALESCE(SUM(session_count), 0)::int AS sessions,
        COUNT(DISTINCT source_app)::int AS apps_used,
        COUNT(DISTINCT date_trunc('day', bucket_start_utc))::int AS active_days,
        MIN(bucket_start_utc) AS first_prompt_at,
        MAX(bucket_start_utc) AS latest_prompt_at
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      `,
      [userId, selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT source_app, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      GROUP BY source_app
      ORDER BY prompts DESC, source_app ASC
      `,
      [userId, selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT date_trunc('hour', bucket_start_utc) AS bucket, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      [userId, selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT date_trunc('day', bucket_start_utc) AS bucket, source_app, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      GROUP BY 1, 2
      ORDER BY 1 ASC, prompts DESC
      `,
      [userId, selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT COALESCE(NULLIF(conversation_type, ''), 'Unknown') AS label, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      GROUP BY 1
      ORDER BY prompts DESC, label ASC
      `,
      [userId, selectedPeriodDays]
    ),
    query<any>(
      `
      SELECT COALESCE(NULLIF(context_type, ''), 'Unknown') AS label, SUM(prompt_count)::int AS prompts
      FROM m365_copilot_interaction_aggregates
      WHERE entra_user_id = $1
        AND ($2::int IS NULL OR bucket_start_utc >= now() - ($2::int * interval '1 day'))
      GROUP BY 1
      ORDER BY prompts DESC, label ASC
      `,
      [userId, selectedPeriodDays]
    ),
    getLatestDataRefreshFinishedAt("copilot_usage_sync"),
  ]);

  const profile = profileRows[0];
  if (!profile) notFound();

  const summary = summaryRows[0] || {};
  const promptCount = Number(summary.prompts || 0);
  const requests = Number(summary.requests || 0);
  const sessions = Number(summary.sessions || 0);
  const displayName = profile.user_label || userId;
  const primaryIdentifier = profile.user_principal_name || userId;

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
        title={displayName}
        subtitle={`Microsoft 365 Copilot usage for ${primaryIdentifier}. Selected report period: ${currentRange.label}.`}
        actions={
          <>
            <Link className="text-muted-foreground hover:underline" href={`/dashboard/copilot?period=${encodeURIComponent(selectedPeriod)}`}>
              Copilot
            </Link>
            <DataRefreshTimestamp sourceLabel="Copilot usage sync" finishedAt={dataRefreshFinishedAt} />
          </>
        }
      />

      <form action={`/dashboard/copilot/users/${encodeURIComponent(userId)}`} method="get">
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
          <ResetFiltersButton href={`/dashboard/copilot/users/${encodeURIComponent(userId)}`} />
          <AppliedFilterTags tags={[{ label: "Report period", value: currentRange.label }]} />
        </FilterBar>
      </form>

      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{userId}</p>
        <p>
          Department {profile.department || "--"} • Office {profile.office_location || "--"}
        </p>
      </div>

      <MetricGrid>
        <MetricCard label="User Prompts" value={formatNumber(promptCount)} detail={currentRange.label} />
        <MetricCard label="Requests" value={formatNumber(requests)} detail={`${formatNumber(sessions)} sessions`} />
        <MetricCard label="Apps Used" value={formatNumber(summary.apps_used)} detail={`${formatNumber(summary.active_days)} active days`} />
        <MetricCard
          label="Latest Prompt"
          value={
            summary.latest_prompt_at ? (
              <LocalDateTime value={toIso(summary.latest_prompt_at)} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            ) : (
              "--"
            )
          }
          detail={
            summary.first_prompt_at ? (
              <>
                First seen{" "}
                <LocalDateTime value={toIso(summary.first_prompt_at)} dateOnly options={{ month: "short", day: "numeric", year: "numeric" }} />
              </>
            ) : (
              "No interaction data in period"
            )
          }
        />
      </MetricGrid>

      <div className="grid gap-3">
        <Card>
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
            <CardTitle>Apps</CardTitle>
            <CardDescription>{currentRange.label} prompt volume by source app</CardDescription>
          </CardHeader>
          <CardContent>
            <SimpleTable
              rows={appRatioData}
              emptyLabel="No app aggregates yet."
              columns={[
                ["App", (row) => row.label || "Unknown"],
                ["Prompts", (row) => formatNumber(row.value)],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversation detail</CardTitle>
            <CardDescription>{currentRange.label} prompt volume by conversation and context type</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <SimpleTable
              rows={conversationRows}
              emptyLabel="No conversation aggregates yet."
              columns={[
                ["Conversation", (row) => row.label || "Unknown"],
                ["Prompts", (row) => formatNumber(row.prompts)],
              ]}
            />
            <SimpleTable
              rows={contextRows}
              emptyLabel="No context aggregates yet."
              columns={[
                ["Context", (row) => row.label || "Unknown"],
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
  const visibleRows = rows.filter((row) => row && Object.keys(row).length > 0);
  if (!visibleRows.length) {
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
          {visibleRows.map((row, index) => (
            <tr key={row.source_period || row.label || index} className="border-t">
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

export default withPageRequestTiming("/dashboard/copilot/users/[userId]", CopilotUserPage);
