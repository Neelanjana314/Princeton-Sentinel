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
import { requireUser } from "@/app/lib/auth";
import { getParam, type SearchParams } from "@/app/lib/params";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/page-header";
import FilterBar from "@/components/filter-bar";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

export const dynamic = "force-dynamic";

// Time range options matching the workbook
const TIME_RANGES = [
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "12", label: "12 hours" },
  { value: "24", label: "1 day" },
  { value: "48", label: "2 days" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
  { value: "336", label: "14 days" },
  { value: "672", label: "28 days" },
  { value: "720", label: "30 days" },
  { value: "1440", label: "60 days" },
  { value: "2160", label: "90 days" },
];

async function AgentsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // ── Parse filters ──
  const hoursParam = getParam(resolvedSearchParams, "hours") || "2160"; // default 90 days
  const hours = Number(hoursParam) || 2160;
  const intervalStr = `${hours} hours`;

  const agentFilter = getParam(resolvedSearchParams, "agent") || "";
  const channelFilter = getParam(resolvedSearchParams, "channel") || "";
  const includeTest = (getParam(resolvedSearchParams, "test") || "true") === "true";

  // ── Build WHERE clauses ──
  const sessionWheres: string[] = ["deleted_at IS NULL"];
  const sessionParams: any[] = [];
  let paramIdx = 1;

  sessionWheres.push(`started_at > now() - interval '${intervalStr}'`);

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
    query<any>(`SELECT DISTINCT bot_id FROM copilot_sessions WHERE deleted_at IS NULL AND bot_id IS NOT NULL AND bot_id != 'Agent' ORDER BY bot_id`),
    query<any>(`SELECT DISTINCT channel FROM copilot_sessions WHERE deleted_at IS NULL AND channel IS NOT NULL AND channel != '' ORDER BY channel`),
  ]);

  // ── Fetch data with filters ──
  // ── Build error WHERE clauses (copilot_errors uses agent_name/channel, not bot_id) ──
  const errorWheres: string[] = [`error_ts > now() - interval '${intervalStr}'`];
  const errorParams: any[] = [];
  let errParamIdx = 1;

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

  const [summaryRows, uniqueUserCountRows, errorCount, topicRows, toolRows, newVsReturnRows, responseTimeRows, singleVsMultiRows, errorsPerAgentRows, errorDetailRows, convsPerAgentRows] = await Promise.all([
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
      `SELECT COUNT(*)::int AS count FROM copilot_errors
       WHERE error_ts > now() - interval '${intervalStr}'`
    ),
    query<any>(
      `SELECT topic_name, avg_duration_sec, median_duration_sec,
              max_duration_sec, execution_count
       FROM copilot_topic_stats
       ORDER BY avg_duration_sec DESC
       LIMIT 10`
    ),
    query<any>(
      `SELECT tool_name, tool_type, total_calls, successful_calls,
              failed_calls, success_rate, avg_duration_sec,
              p50_duration_sec, p95_duration_sec
       FROM copilot_tool_stats
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
      `SELECT time_bucket, avg_response_sec, p50_response_sec,
              p95_response_sec, p99_response_sec, total_responses
       FROM copilot_response_times
       WHERE time_bucket > now() - interval '${intervalStr}'
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
       WHERE ${errorWhere}
       GROUP BY agent_name
       ORDER BY errors DESC`,
      errorParams
    ),
    // Error details (latest 100)
    query<any>(
      `SELECT
         e.error_ts, e.agent_name, e.channel, e.session_id,
         e.error_code, e.error_message
       FROM copilot_errors e
       WHERE ${errorWhere}
       ORDER BY e.error_ts DESC
       LIMIT 100`,
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
  ]);

  // ── Aggregate metrics ──
  let totalSessions = 0;
  let totalResolved = 0;
  let totalEscalated = 0;
  let totalAbandoned = 0;
  let turnSum = 0;
  let durationSum = 0;
  let durationCount = 0;
  const totalUniqueUsers = Number(uniqueUserCountRows[0]?.unique_users || 0);
  let totalErrors = Number(errorCount[0]?.count || 0);

  for (const r of summaryRows) {
    totalSessions += Number(r.total_sessions || 0);
    totalResolved += Number(r.resolved || 0);
    totalEscalated += Number(r.escalated || 0);
    totalAbandoned += Number(r.abandoned || 0);
    turnSum += Number(r.avg_turns || 0) * Number(r.total_sessions || 0);
    const dur = Number(r.avg_duration_min || 0);
    if (dur > 0) {
      durationSum += dur * Number(r.total_sessions || 0);
      durationCount += Number(r.total_sessions || 0);
    }
  }

  const avgDuration = durationCount > 0 ? (durationSum / durationCount).toFixed(1) : "0";

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
    .map(([label, value]) => ({ label, value }));

  const dailyUsers = Array.from(dailyUsersMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));

  const outcomePie = [
    { label: "Resolved", value: totalResolved },
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
    return { label: shortName, value: Number(t.avg_duration_sec || 0) };
  });

  const toolDurationData = toolRows.map((t: any) => ({
    label: t.tool_name ?? "unknown",
    value: Number(t.avg_duration_sec || 0),
  }));

  const toolSuccessData = toolRows.map((t: any) => ({
    label: t.tool_name ?? "unknown",
    success: Number(t.successful_calls || 0),
    failure: Number(t.failed_calls || 0),
  }));

  // ── Response time data ──
  const responseTimeData = responseTimeRows.map((r: any) => {
    const ts = typeof r.time_bucket === "string" ? r.time_bucket : new Date(r.time_bucket).toISOString();
    const label = ts.slice(5, 16).replace("T", " "); // "MM-DD HH:mm"
    return {
      label,
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
    timestamp: typeof e.error_ts === "string" ? e.error_ts : new Date(e.error_ts).toISOString(),
    agent: e.agent_name ?? "Unknown",
    channel: e.channel ?? "",
    sessionId: e.session_id ?? "",
    errorCode: e.error_code ?? "",
    errorMessage: e.error_message ?? "",
  }));

  const currentRange = TIME_RANGES.find((t) => t.value === hoursParam) ?? TIME_RANGES[TIME_RANGES.length - 1];

  return (
    <main className="ps-page">
      <PageHeader
        title="Agents"
        subtitle={`Agent telemetry via Application Insights. Window: ${currentRange.label}.`}
      />

      {/* ── Filters ── */}
      <form action="/dashboard/agents" method="get">
        <FilterBar>
          <select
            name="hours"
            defaultValue={hoursParam}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            {TIME_RANGES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>

          <select
            name="agent"
            defaultValue={agentFilter || "*"}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="*">All Agents</option>
            {agentOptions.map((a: any) => (
              <option key={a.bot_id} value={a.bot_id}>{a.bot_id}</option>
            ))}
          </select>

          <select
            name="channel"
            defaultValue={channelFilter || "*"}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="*">All Channels</option>
            {channelOptions.map((c: any) => (
              <option key={c.channel} value={c.channel}>{c.channel}</option>
            ))}
          </select>

          <select
            name="test"
            defaultValue={includeTest ? "true" : "false"}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="true">Include Test Data</option>
            <option value="false">Production Only</option>
          </select>

          <Button type="submit" variant="outline">
            Apply
          </Button>
        </FilterBar>
      </form>

      {/* ── Overview ── */}
      <MetricGrid>
        <MetricCard label="Total Conversations" value={totalSessions.toLocaleString()} />
        <MetricCard label="Unique Users" value={totalUniqueUsers.toLocaleString()} />
        <MetricCard label="Avg Duration" value={`${avgDuration} mins`} />
        <MetricCard label="Errors" value={totalErrors.toLocaleString()} />
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

        <Card>
          <CardHeader>
            <CardTitle>Conversation outcomes</CardTitle>
            <CardDescription>Resolved vs escalated vs abandoned</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotOutcomePieChartClient data={outcomePie} />
          </CardContent>
        </Card>
      </div>

      {/* ── User Analytics ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">User Analytics</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Daily active users</CardTitle>
            <CardDescription>Unique users interacting with agents per day</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotDailyUsersAreaChartClient data={dailyUsers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New vs return users</CardTitle>
            <CardDescription>User retention breakdown</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotNewVsReturnPieChartClient data={newVsReturn} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Single-turn vs multi-turn</CardTitle>
            <CardDescription>Conversation complexity breakdown</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotOutcomePieChartClient data={singleVsMulti} />
          </CardContent>
        </Card>
      </div>

      {/* ── Performance ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">Performance</h2>
      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Agent response time</CardTitle>
            <CardDescription>BotMessageReceived → BotMessageSend latency over time (Avg, P50, P95, P99)</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotResponseTimeAreaChartClient data={responseTimeData} />
          </CardContent>
        </Card>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tool response time</CardTitle>
            <CardDescription>Top 10 slowest tools/connectors (avg seconds)</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotToolBarChartClient data={toolDurationData} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tool success rate</CardTitle>
            <CardDescription>Successful vs failed calls per tool</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <CopilotToolSuccessRateBarChartClient data={toolSuccessData} />
          </CardContent>
        </Card>
      </div>

      {/* ── Topic Analytics ── */}
      <h2 className="mt-6 mb-3 text-lg font-semibold">Topic Analytics</h2>
      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Topic execution (top 10 slowest)</CardTitle>
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
          <CardTitle>Errors per agent</CardTitle>
          <CardDescription>Error count, rate, and risk level per agent</CardDescription>
        </CardHeader>
        <CardContent>
          {errorsPerAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors in this time range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
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
          <CardDescription>Recent errors with timestamp and conversation ID (latest 100)</CardDescription>
        </CardHeader>
        <CardContent>
          {errorDetails.length === 0 ? (
            <p className="text-sm text-muted-foreground">No errors in this time range.</p>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left">
                    <th className="pb-2 pr-4 font-medium">Timestamp</th>
                    <th className="pb-2 pr-4 font-medium">Agent</th>
                    <th className="pb-2 pr-4 font-medium">Channel</th>
                    <th className="pb-2 pr-4 font-medium">Conversation ID</th>
                    <th className="pb-2 pr-4 font-medium">Error Code</th>
                    <th className="pb-2 font-medium">Error Message</th>
                  </tr>
                </thead>
                <tbody>
                  {errorDetails.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap">{row.timestamp.slice(0, 19).replace("T", " ")}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.agent}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.channel || "—"}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{row.sessionId || "—"}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.errorCode || "—"}</td>
                      <td className="py-2 max-w-md truncate" title={row.errorMessage}>{row.errorMessage || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/dashboard/agents", AgentsPage);
