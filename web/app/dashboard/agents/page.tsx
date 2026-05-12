import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CopilotSessionsBarChartClient,
  CopilotOutcomePieChartClient,
  CopilotDailyUsersAreaChartClient,
  CopilotNewVsReturnPieChartClient,
  CopilotTopicBarChartClient,
  CopilotToolBarChartClient,
  CopilotToolSuccessRateBarChartClient,
  CopilotResponseTimeAreaChartClient,
} from "@/components/copilot-charts-client";
import { query } from "@/app/lib/db";
import { requireUser, isAdmin } from "@/app/lib/auth";
import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";
import { formatDate, formatIsoDate } from "@/app/lib/format";
import AgentAccessControl from "@/components/agent-access-control";
import { getParam, type SearchParams } from "@/app/lib/params";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/page-header";
import FilterBar, { AppliedFilterTags, FilterField, ResetFiltersButton } from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";
import { UniqueUsersCard, TotalConversationsCard, EscalatedOutcomeCard } from "@/components/unique-users-card";
import { InfoTooltip } from "@/components/info-tooltip";
import { ErrorDetailsTable } from "./error-details-table";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";

export const dynamic = "force-dynamic";

const DEFAULT_TIME_RANGE_VALUE = "720";

const TIME_RANGES = [
  { value: "24", label: "1 day" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
  { value: "2160", label: "90 days" },
  { value: "4320", label: "180 days" },
  { value: "all", label: "All" },
];

function formatAllFilter(value: string, allLabel: string) {
  return value && value !== "*" ? value : allLabel;
}

async function AgentsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const { groups } = await requireUser();
  await redirectIfFeatureDisabled("agents_dashboard");
  const adminUser = await isAdmin(groups);

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // ── Parse filters ──
  const requestedHoursParam = getParam(resolvedSearchParams, "hours") || DEFAULT_TIME_RANGE_VALUE;
  const selectedRange = TIME_RANGES.find((t) => t.value === requestedHoursParam) ?? TIME_RANGES.find((t) => t.value === DEFAULT_TIME_RANGE_VALUE)!;
  const hoursParam = selectedRange.value;
  const intervalStr = hoursParam === "all" ? null : `${hoursParam} hours`;

  // Dynamic grain matching Azure Workbook's {TimeRange:grain}
  const grainStr = "2 hours";

  const agentFilter = getParam(resolvedSearchParams, "agent") || "";
  const channelFilter = getParam(resolvedSearchParams, "channel") || "";
  const includeTest = (getParam(resolvedSearchParams, "test") || "true") === "true";

  // ── Build WHERE clauses ──
  const sessionWheres: string[] = ["deleted_at IS NULL"];
  const sessionParams: any[] = [];
  let paramIdx = 1;

  if (intervalStr) {
    sessionWheres.push(`started_at > now() - interval '${intervalStr}'`);
  }

  if (agentFilter && agentFilter !== "*") {
    sessionWheres.push(`bot_id = $${paramIdx}`);
    sessionParams.push(agentFilter);
    paramIdx++;
  }
  if (channelFilter && channelFilter !== "*") {
    sessionWheres.push(`channel = $${paramIdx}`);
    sessionParams.push(channelFilter);
    paramIdx++;
  }
  if (!includeTest) {
    sessionWheres.push(`is_test = false`);
  }

  const sessionWhere = sessionWheres.join(" AND ");

  // ── Fetch filter options ──
  const [agentOptions, channelOptions] = await Promise.all([
    query<any>(`SELECT DISTINCT bot_id FROM copilot_sessions WHERE deleted_at IS NULL AND bot_id IS NOT NULL AND bot_id != 'Agent'${intervalStr ? ` AND started_at > now() - interval '${intervalStr}'` : ""} ORDER BY bot_id`),
    query<any>(`SELECT DISTINCT channel FROM copilot_sessions WHERE deleted_at IS NULL AND channel IS NOT NULL AND channel != ''${intervalStr ? ` AND started_at > now() - interval '${intervalStr}'` : ""} ORDER BY channel`),
  ]);

  // ── Fetch data with filters ──
  // ── Build error WHERE clauses (copilot_errors uses agent_name/channel, not bot_id) ──
  const errorWheres: string[] = ["TRUE"];
  const errorParams: any[] = [];
  let errParamIdx = 1;

  if (intervalStr) {
    errorWheres.push(`error_ts > now() - interval '${intervalStr}'`);
  }

  if (agentFilter && agentFilter !== "*") {
    errorWheres.push(`agent_name = $${errParamIdx}`);
    errorParams.push(agentFilter);
    errParamIdx++;
  }
  if (channelFilter && channelFilter !== "*") {
    errorWheres.push(`channel = $${errParamIdx}`);
    errorParams.push(channelFilter);
    errParamIdx++;
  }
  const errorWhere = errorWheres.join(" AND ");
  // For queries that alias copilot_errors as "e", session_id must be qualified
  const errorWhereAliased = [
    ...errorWheres,
    ...(!includeTest ? [`e.session_id IN (SELECT session_id FROM copilot_sessions WHERE is_test = false AND deleted_at IS NULL)`] : []),
  ].join(" AND ");
  // For unaliased queries, no qualification needed
  const errorWhereWithTest = !includeTest
    ? errorWhere + ` AND session_id IN (SELECT session_id FROM copilot_sessions WHERE is_test = false AND deleted_at IS NULL)`
    : errorWhere;

  const [summaryRows, uniqueUserCountRows, uniqueUserIdRows, errorCount, avgDurationRows, topicRows, toolRows, newVsReturnRows, responseTimeRows, singleVsMultiRows, errorsPerAgentRows, errorDetailRows, convsPerAgentRows, latestSessionRows, escalatedRows, dataRefreshFinishedAt] = await Promise.all([
    query<any>(
      `SELECT
         date_trunc('day', started_at)::date AS day,
         COUNT(*)::int AS total_sessions,
         COALESCE(AVG(turn_count), 0)::numeric(6,1) AS avg_turns,
         COUNT(*) FILTER (WHERE outcome = 'resolved')::int AS resolved,
         COUNT(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
         COUNT(*) FILTER (WHERE outcome = 'abandoned')::int AS abandoned,
         COUNT(DISTINCT user_id)::int AS unique_users,
         COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)
           FILTER (WHERE ended_at > started_at
                     AND EXTRACT(EPOCH FROM (ended_at - started_at)) <= 3600),
           0)::numeric(6,1) AS avg_duration_min
       FROM copilot_sessions
       WHERE ${sessionWhere}
       GROUP BY 1
       ORDER BY day DESC`,
      sessionParams
    ),
    query<any>(
      `SELECT COUNT(DISTINCT user_id)::int AS unique_users
       FROM copilot_sessions
       WHERE ${sessionWhere}`,
      sessionParams
    ),
    query<any>(
      `SELECT
         sub.user_id,
         COALESCE(u.display_name, sub.user_name) AS display_name,
         COALESCE(u.mail, u.user_principal_name) AS email,
         sub.channel,
         sub.bot_id,
         sub.started_at
       FROM (
         SELECT DISTINCT ON (user_id) user_id, user_name, channel, bot_id, started_at
         FROM copilot_sessions
         WHERE ${sessionWhere} AND user_id IS NOT NULL
         ORDER BY user_id, started_at DESC
       ) sub
       LEFT JOIN msgraph_users u ON u.id = sub.user_id AND u.deleted_at IS NULL
       ORDER BY display_name NULLS LAST
       LIMIT 500`,
      sessionParams
    ),
    query<any>(
      `SELECT COUNT(*)::int AS count FROM copilot_errors
       WHERE ${errorWhereWithTest}`,
      errorParams
    ),
    // Simple avg duration (not weighted) — matches workbook logic
    query<any>(
      `SELECT COALESCE(
         ROUND(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)::numeric, 1),
         0
       ) AS avg_duration_min
       FROM copilot_sessions
       WHERE ${sessionWhere}
         AND ended_at > started_at
         AND EXTRACT(EPOCH FROM (ended_at - started_at)) <= 3600`,
      sessionParams
    ),
    query<any>(
      `SELECT
         topic_name,
         bot_id,
         ROUND((SUM(avg_duration_sec * execution_count) / NULLIF(SUM(execution_count), 0))::numeric, 2) AS avg_duration_sec,
         ROUND(AVG(median_duration_sec)::numeric, 2) AS median_duration_sec,
         ROUND(MAX(max_duration_sec)::numeric, 2) AS max_duration_sec,
         SUM(execution_count)::int AS execution_count
       FROM copilot_topic_stats_hourly
       WHERE TRUE
         ${intervalStr ? `AND time_bucket > now() - interval '${intervalStr}'` : ""}
         ${agentFilter && agentFilter !== "*" ? `AND bot_id = '${agentFilter.replace(/'/g, "''")}'` : ""}
         ${channelFilter && channelFilter !== "*" ? `AND channel = '${channelFilter.replace(/'/g, "''")}'` : ""}
         ${!includeTest ? "AND is_test = false" : ""}
       GROUP BY topic_name, bot_id
       ORDER BY avg_duration_sec DESC
       LIMIT 10`
    ),
    query<any>(
      `SELECT
         tool_name,
         tool_type,
         bot_id,
         SUM(total_calls)::int AS total_calls,
         SUM(successful_calls)::int AS successful_calls,
         SUM(failed_calls)::int AS failed_calls,
         ROUND((SUM(avg_duration_sec * total_calls) / NULLIF(SUM(total_calls), 0))::numeric, 2) AS avg_duration_sec,
         ROUND((SUM(p50_duration_sec * total_calls) / NULLIF(SUM(total_calls), 0))::numeric, 2) AS p50_duration_sec,
         ROUND((SUM(p95_duration_sec * total_calls) / NULLIF(SUM(total_calls), 0))::numeric, 2) AS p95_duration_sec,
         ROUND((SUM(successful_calls) * 100.0 / NULLIF(SUM(total_calls), 0))::numeric, 2) AS success_rate
       FROM copilot_tool_stats_hourly
       WHERE tool_name IS NOT NULL AND tool_name != ''
         ${intervalStr ? `AND time_bucket > now() - interval '${intervalStr}'` : ""}
         ${agentFilter && agentFilter !== "*" ? `AND bot_id = '${agentFilter.replace(/'/g, "''")}'` : ""}
         ${channelFilter && channelFilter !== "*" ? `AND channel = '${channelFilter.replace(/'/g, "''")}'` : ""}
         ${!includeTest ? "AND is_test = false" : ""}
       GROUP BY tool_name, tool_type, bot_id
       ORDER BY avg_duration_sec DESC
       LIMIT 10`
    ),
    query<any>(
      `SELECT
         CASE WHEN conv_count > 1 THEN 'Return User' ELSE 'New User' END AS user_type,
         COUNT(*)::int AS user_count
       FROM (
         SELECT user_id, COUNT(DISTINCT session_id) AS conv_count
         FROM copilot_sessions
         WHERE ${sessionWhere} AND user_id IS NOT NULL
         GROUP BY user_id
       ) u
       GROUP BY 1`,
      sessionParams
    ),
    query<any>(
      `SELECT
         date_bin('${grainStr}', time_bucket, '2000-01-01') AS time_bucket,
         ROUND((SUM(avg_response_sec * total_responses) / NULLIF(SUM(total_responses), 0))::numeric, 2) AS avg_response_sec,
         ROUND((SUM(p50_response_sec * total_responses) / NULLIF(SUM(total_responses), 0))::numeric, 2) AS p50_response_sec,
         ROUND((SUM(p95_response_sec * total_responses) / NULLIF(SUM(total_responses), 0))::numeric, 2) AS p95_response_sec,
         ROUND((SUM(p99_response_sec * total_responses) / NULLIF(SUM(total_responses), 0))::numeric, 2) AS p99_response_sec,
         SUM(total_responses)::int AS total_responses
       FROM copilot_response_times
       WHERE TRUE
         ${intervalStr ? `AND time_bucket > now() - interval '${intervalStr}'` : ""}
         ${agentFilter && agentFilter !== "*" ? `AND bot_id = '${agentFilter.replace(/'/g, "''")}'` : ""}
         ${channelFilter && channelFilter !== "*" ? `AND channel = '${channelFilter.replace(/'/g, "''")}'` : ""}
         ${!includeTest ? "AND is_test = false" : ""}
       GROUP BY time_bucket
       HAVING SUM(total_responses) > 0
       ORDER BY time_bucket ASC`
    ),
    query<any>(
      `SELECT
         CASE WHEN turn_count > 1 THEN 'Multi-turn' ELSE 'Single-turn' END AS conv_type,
         COUNT(*)::int AS conv_count
       FROM copilot_sessions
       WHERE ${sessionWhere}
       GROUP BY 1`,
      sessionParams
    ),
    // Errors per agent
    query<any>(
      `SELECT agent_name, COUNT(*)::int AS errors
       FROM copilot_errors
       WHERE ${errorWhereWithTest}
       GROUP BY agent_name
       ORDER BY errors DESC`,
      errorParams
    ),
    // Error details (latest 100)
    query<any>(
      `SELECT
         e.error_ts, e.agent_name, e.channel, e.session_id,
         e.error_code, e.error_message,
         COALESCE(u.display_name, cs.user_name) AS user_display_name
       FROM copilot_errors e
       LEFT JOIN (
         SELECT session_id, user_id, user_name
         FROM copilot_sessions
         WHERE deleted_at IS NULL
       ) cs ON cs.session_id = e.session_id
       LEFT JOIN msgraph_users u ON u.id = cs.user_id AND u.deleted_at IS NULL
       WHERE ${errorWhereAliased}
       ORDER BY e.error_ts DESC`,
      errorParams
    ),
    // Conversations per agent (for error rate calculation)
    query<any>(
      `SELECT bot_id, COUNT(DISTINCT session_id)::int AS conversations
       FROM copilot_sessions
       WHERE ${sessionWhere}
       GROUP BY bot_id`,
      sessionParams
    ),
    // Latest 10 conversation IDs with agent name
    query<any>(
      `SELECT session_id, bot_id, started_at
       FROM copilot_sessions
       WHERE ${sessionWhere} AND session_id IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 10`,
      sessionParams
    ),
    // Escalated conversations with error reason (for outcome hover)
    query<any>(
      `SELECT s.session_id, s.bot_id, s.started_at,
              (SELECT e.error_code FROM copilot_errors e
               WHERE e.session_id = s.session_id
               ORDER BY e.error_ts DESC LIMIT 1) AS error_reason
       FROM copilot_sessions s
       WHERE ${sessionWhere} AND s.outcome = 'escalated'
       ORDER BY s.started_at DESC
       LIMIT 50`,
      sessionParams
    ),
    getLatestDataRefreshFinishedAt("copilot_telemetry"),
  ]);

  // ── Aggregate metrics ──
  let totalSessions = 0;
  let totalResolved = 0;
  let totalEscalated = 0;
  let totalAbandoned = 0;
  let turnSum = 0;
  const totalUniqueUsers = Number(uniqueUserCountRows[0]?.unique_users || 0);
  let totalErrors = Number(errorCount[0]?.count || 0);
  const avgDuration = String(avgDurationRows[0]?.avg_duration_min ?? "0");
  const uniqueUserIds: { displayName: string | null; email: string | null; channel: string | null; agent: string | null; startedAt: string | null }[] = uniqueUserIdRows.map((r: any) => ({
    displayName: r.display_name ? String(r.display_name) : null,
    email: r.email ? String(r.email) : (r.user_id ? String(r.user_id) : null),
    channel: r.channel ? String(r.channel) : null,
    agent: r.bot_id ? String(r.bot_id) : null,
    startedAt: r.started_at ? (typeof r.started_at === "string" ? r.started_at : new Date(r.started_at).toISOString()) : null,
  }));
  const latestSessions: { id: string; agent: string }[] = latestSessionRows.map((r: any) => ({
    id: String(r.session_id),
    agent: r.bot_id ?? "Unknown",
  }));
  const escalatedSessions: { id: string; agent: string; datetime: string; reason: string }[] = escalatedRows.map((r: any) => ({
    id: String(r.session_id),
    agent: r.bot_id ?? "Unknown",
    datetime: typeof r.started_at === "string" ? r.started_at.slice(0, 19).replace("T", " ") : new Date(r.started_at).toISOString().slice(0, 19).replace("T", " "),
    reason: r.error_reason ?? "Unknown",
  }));

  for (const r of summaryRows) {
    totalSessions += Number(r.total_sessions || 0);
    totalResolved += Number(r.resolved || 0);
    totalEscalated += Number(r.escalated || 0);
    totalAbandoned += Number(r.abandoned || 0);
    turnSum += Number(r.avg_turns || 0) * Number(r.total_sessions || 0);
  }

  // ── Chart data ──
  const dailyMap = new Map<string, number>();
  const dailyUsersMap = new Map<string, number>();
  for (const r of summaryRows) {
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + Number(r.total_sessions || 0));
    dailyUsersMap.set(day, (dailyUsersMap.get(day) ?? 0) + Number(r.unique_users || 0));
  }

  const dailySessions = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label: formatIsoDate(label), value }));

  const dailyUsers = Array.from(dailyUsersMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label: formatIsoDate(label), value }));

  const outcomePie = [
    { label: "No Error Marked", value: totalResolved },
    { label: "Escalated", value: totalEscalated },
    { label: "Abandoned", value: totalAbandoned },
  ].filter((d) => d.value > 0);

  const newVsReturn = newVsReturnRows.map((r: any) => ({
    label: r.user_type ?? "Unknown",
    value: Number(r.user_count || 0),
  })).filter((d: any) => d.value > 0);

  const topicData = topicRows.map((t: any) => {
    const name = t.topic_name ?? "unknown";
    const shortName = name.includes(".") ? name.split(".").pop()! : name;
    const agent = t.bot_id ?? "";
    const label = agent ? `${shortName} · ${agent}` : shortName;
    return { label, value: Number(t.avg_duration_sec || 0) };
  });

  const toolDurationData = toolRows.map((t: any) => {
    const agent = t.bot_id ?? "";
    const label = agent ? `${t.tool_name ?? "unknown"} · ${agent}` : (t.tool_name ?? "unknown");
    return { label, value: Number(t.avg_duration_sec || 0) };
  });

  const toolSuccessData = toolRows.map((t: any) => ({
    label: t.tool_name ?? "unknown",
    success: Number(t.successful_calls || 0),
    failure: Number(t.failed_calls || 0),
  }));

  // ── Response time data ──
  const responseTimeData = responseTimeRows.map((r: any) => {
    const rawBucket = r.time_bucket ?? r.bucket;
    const ts = typeof rawBucket === "string" ? rawBucket : new Date(rawBucket).toISOString();
    return {
      label: formatDate(ts, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }),
      avg: Number(r.avg_response_sec || 0),
      p50: Number(r.p50_response_sec || 0),
      p95: Number(r.p95_response_sec || 0),
      p99: Number(r.p99_response_sec || 0),
    };
  });

  // ── Single vs multi-turn ──
  const singleVsMulti = singleVsMultiRows.map((r: any) => ({
    label: r.conv_type ?? "Unknown",
    value: Number(r.conv_count || 0),
  })).filter((d: any) => d.value > 0);

  // ── Errors per agent with risk level ──
  const convsPerAgent = new Map<string, number>();
  for (const r of convsPerAgentRows) {
    convsPerAgent.set(r.bot_id, Number(r.conversations || 0));
  }

  const errorsPerAgent = errorsPerAgentRows.map((r: any) => {
    const errors = Number(r.errors || 0);
    const conversations = convsPerAgent.get(r.agent_name) ?? 0;
    const errorRate = conversations > 0 ? Math.round(errors * 10000.0 / conversations) / 100 : 0;
    const risk =
      errors >= 50 || errorRate >= 5.0 ? "CRITICAL" :
      errors >= 10 || errorRate >= 1.0 ? "WARNING" : "HEALTHY";
    return {
      agent: r.agent_name ?? "Unknown",
      errors,
      conversations,
      errorRate,
      risk,
    };
  });

  // ── Agent risk status (worst agent) ──
  const worstAgent = errorsPerAgent.length > 0
    ? errorsPerAgent.reduce((prev, curr) =>
        curr.errors > prev.errors ? curr : prev
      )
    : null;

  // Top error cause for worst agent
  const worstAgentTopError = worstAgent
    ? errorDetailRows.find((e: any) => e.agent_name === worstAgent.agent)
    : null;

  // ── Error details ──
  const errorDetails = errorDetailRows.map((e: any) => ({
    timestamp: e.error_ts ?? null,
    agent: e.agent_name ?? "Unknown",
    channel: e.channel ?? "",
    sessionId: e.session_id ?? "",
    errorCode: e.error_code ?? "",
    errorMessage: e.error_message ?? "",
    userName: e.user_display_name ?? "",
  }));

  const currentRange = selectedRange;

  return (
    <main className="ps-page">
      <PageHeader
        title="Custom Agents Telemetry and Controls"
        subtitle={`Agent telemetry via Application Insights. Window: ${currentRange.label}.`}
        actions={<DataRefreshTimestamp sourceLabel="Custom agent telemetry sync" finishedAt={dataRefreshFinishedAt} />}
      />

      {/* ── Filters ── */}
      <form action="/dashboard/agents" method="get">
        <FilterBar>
          <FilterField label="Time range">
            <select
              name="hours"
              defaultValue={hoursParam}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              {TIME_RANGES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Agent">
            <select
              name="agent"
              defaultValue={agentFilter || "*"}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="*">All Agents</option>
              {agentOptions.map((a: any) => (
                <option key={a.bot_id} value={a.bot_id}>{a.bot_id}</option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Channel">
            <select
              name="channel"
              defaultValue={channelFilter || "*"}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="*">All Channels</option>
              {channelOptions.map((c: any) => (
                <option key={c.channel} value={c.channel}>{c.channel}</option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Test data">
            <select
              name="test"
              defaultValue={includeTest ? "true" : "false"}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="true">Include Test Data</option>
              <option value="false">Production Only</option>
            </select>
          </FilterField>

          <Button type="submit" variant="outline" className="self-end">
            Apply
          </Button>
          <ResetFiltersButton href="/dashboard/agents" />
          <AppliedFilterTags
            tags={[
              { label: "Time range", value: currentRange.label },
              { label: "Agent", value: formatAllFilter(agentFilter, "All Agents") },
              { label: "Channel", value: formatAllFilter(channelFilter, "All Channels") },
              { label: "Test data", value: includeTest ? "Include Test Data" : "Production Only" },
            ]}
          />
        </FilterBar>
      </form>

      {/* ── Admin: Agent Access Control (kill switch) ── */}
      {adminUser && <AgentAccessControl />}

      {/* ── Overview ── */}
      <MetricGrid>
        <TotalConversationsCard count={totalSessions.toLocaleString()} sessions={latestSessions} />
        <UniqueUsersCard count={totalUniqueUsers.toLocaleString()} userIds={uniqueUserIds} />
        <MetricCard label="Avg Duration" value={`${avgDuration} mins`} info={"Average conversation duration in minutes.\nCalculated as the mean of (ended_at − started_at) across sessions where the duration is between 0 and 60 minutes. Sessions outside this range are excluded as outliers."} />
        <MetricCard label="Errors" value={totalErrors.toLocaleString()} info="Total count of OnErrorLog events recorded by Copilot Studio in the selected time range. Each error corresponds to a failed action, topic, or connector call within a conversation." />
      </MetricGrid>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Daily conversations</CardTitle>
            <CardDescription>Agent conversations per day</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotSessionsBarChartClient data={dailySessions} />
          </CardContent>
        </Card>

        <EscalatedOutcomeCard escalatedCount={totalEscalated} escalatedSessions={escalatedSessions}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Conversation outcomes
                <InfoTooltip label={"No error marked: the session had at least 1 exchange and no errors logged.\nEscalated: user asked for a live agent or the conversation hit an error.\nAbandoned: the session started but no messages were exchanged (turn count = 0)."} />
              </CardTitle>
              <CardDescription>No error marked vs escalated vs abandoned</CardDescription>
            </CardHeader>
            <CardContent className="h-72">
              <CopilotOutcomePieChartClient data={outcomePie} />
            </CardContent>
          </Card>
        </EscalatedOutcomeCard>
      </div>

      {/* ── User Analytics ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">User Analytics</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Daily active users
              <InfoTooltip label="Number of distinct users who started at least one conversation on each day. A spike indicates high adoption or a specific event. A drop may signal downtime or reduced engagement." />
            </CardTitle>
            <CardDescription>Unique users interacting with agents per day</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotDailyUsersAreaChartClient data={dailyUsers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              New vs return users
              <InfoTooltip label={"New User: had exactly 1 conversation in the selected time range.\nReturn User: had 2 or more conversations, indicating they came back to use the agent again."} />
            </CardTitle>
            <CardDescription>User retention breakdown</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotNewVsReturnPieChartClient data={newVsReturn} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Single-turn vs multi-turn
              <InfoTooltip label={"Single-turn: conversations with only 1 user message — typically simple queries or dead-ends.\nMulti-turn: 2 or more back-and-forth exchanges, indicating deeper engagement."} />
            </CardTitle>
            <CardDescription>Conversation complexity &amp; engagement</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotOutcomePieChartClient data={singleVsMulti} />
          </CardContent>
        </Card>
      </div>

      {/* ── Performance ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">Performance</h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Agent response time
            <InfoTooltip label={"Latency between BotMessageReceived and BotMessageSend events — how long the agent takes to reply.\nAvg: mean response time across all messages.\nP50 (median): half of responses are faster than this — a good baseline.\nP95: 95% of responses are faster — shows the experience for most users.\nP99: only 1% of responses are slower — highlights worst-case spikes.\nA rising P95/P99 while Avg stays flat usually means occasional slow outliers, not a general slowdown."} />
          </CardTitle>
          <CardDescription>Agent message received → Agent message sent latency over time (Avg, P50, P95, P99)</CardDescription>
        </CardHeader>
        <CardContent className="h-96 pr-6">
          <CopilotResponseTimeAreaChartClient data={responseTimeData} />
        </CardContent>
      </Card>
      <div className="mt-3 grid gap-3 grid-cols-5">
        <Card className="col-span-3">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Tool response time
              <InfoTooltip label={"Average time in seconds for each tool or connector to respond, showing the top 10 slowest.\nTools are Power Automate flows, HTTP connectors, or custom actions called by the agent during a conversation.\nA slow tool directly adds to the user's perceived wait time — high values here are the first place to investigate if agent response time is degraded."} />
            </CardTitle>
            <CardDescription>Top 10 slowest tools/connectors (avg seconds)</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotToolBarChartClient data={toolDurationData} />
          </CardContent>
        </Card>

        <Card className="col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Tool success rate
              <InfoTooltip label={"Ratio of successful to failed calls for each tool or connector.\nA low success rate on a tool means it is frequently erroring out — which often causes escalations or abandoned conversations.\nCross-reference with Tool Response Time: a slow AND unreliable tool is the highest priority to fix."} />
            </CardTitle>
            <CardDescription>Successful vs failed calls per tool</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotToolSuccessRateBarChartClient data={toolSuccessData} />
          </CardContent>
        </Card>
      </div>

      {/* ── Topic Analytics ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">Topic Analytics</h2>
      <div className="grid gap-3 grid-cols-5">
        <Card className="col-span-5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Topic execution (top 10 slowest)
              <InfoTooltip label={"Average time in seconds from TopicStart to TopicEnd for each Copilot Studio topic, showing the 10 slowest.\nTopics are the named conversation flows defined in Copilot Studio (e.g. 'Check Order Status', 'Reset Password').\nSlow topics usually indicate a slow tool call within them — use this alongside Tool Response Time to trace the root cause."} />
            </CardTitle>
            <CardDescription>Average processing time per topic in seconds</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotTopicBarChartClient data={topicData} />
          </CardContent>
        </Card>
      </div>

      {/* ── Error Analytics ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">Error Analytics</h2>

      {/* Agent Risk Status (worst agent) */}
      {worstAgent && (
        <Card className={`mb-3 border-l-4 ${
          worstAgent.risk === "CRITICAL" ? "border-l-red-500 bg-red-50 dark:bg-red-950/20" :
          worstAgent.risk === "WARNING" ? "border-l-yellow-500 bg-yellow-50 dark:bg-yellow-950/20" :
          "border-l-green-500 bg-green-50 dark:bg-green-950/20"
        }`}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              Risk (worst agent): {worstAgent.agent}
              <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                worstAgent.risk === "CRITICAL" ? "bg-red-500 text-white" :
                worstAgent.risk === "WARNING" ? "bg-yellow-500 text-black" :
                "bg-green-500 text-white"
              }`}>{worstAgent.risk}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-sm">
              Errors: <strong>{worstAgent.errors}</strong> | Rate: <strong>{worstAgent.errorRate}%</strong> | Conversations: <strong>{worstAgent.conversations}</strong>
            </p>
            {worstAgentTopError && (
              <p className="mt-1 text-xs text-muted-foreground">
                Top code: {worstAgentTopError.error_code || "N/A"} | Sample: {(worstAgentTopError.error_message || "N/A").slice(0, 120)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Errors Per Agent */}
      <Card className="mb-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Errors per agent
            <InfoTooltip label={"CRITICAL = ≥ 50 errors or error rate ≥ 5%.\nWARNING = ≥ 10 errors or error rate ≥ 1%.\nHEALTHY = below both thresholds."} />
          </CardTitle>
          <CardDescription>Error count, rate, and risk level per agent</CardDescription>
        </CardHeader>
        <CardContent>
          {errorsPerAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors in this time range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="ps-table">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 pr-4 font-medium">Agent</th>
                    <th className="pb-2 pr-4 font-medium text-right">Errors</th>
                    <th className="pb-2 pr-4 font-medium text-right">Conversations</th>
                    <th className="pb-2 pr-4 font-medium text-right">Error Rate %</th>
                    <th className="pb-2 font-medium">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {errorsPerAgent.map((row) => (
                    <tr key={row.agent} className="border-b last:border-0">
                      <td className="py-2 pr-4">{row.agent}</td>
                      <td className="py-2 pr-4 text-right">{row.errors}</td>
                      <td className="py-2 pr-4 text-right">{row.conversations}</td>
                      <td className="py-2 pr-4 text-right">{row.errorRate}%</td>
                      <td className="py-2">
                        <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                          row.risk === "CRITICAL" ? "bg-red-500 text-white" :
                          row.risk === "WARNING" ? "bg-yellow-500 text-black" :
                          "bg-green-500 text-white"
                        }`}>{row.risk}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error Details */}
      <Card>
        <CardHeader>
          <CardTitle>Error details</CardTitle>
          <CardDescription>Recent errors. Click a column header to sort.</CardDescription>
        </CardHeader>
        <CardContent>
          {errorDetails.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors in this time range.</p>
          ) : (
            <ErrorDetailsTable items={errorDetails} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/dashboard/agents", AgentsPage);
