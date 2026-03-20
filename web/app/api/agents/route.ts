import { NextResponse } from "next/server";
import { query } from "@/app/lib/db";
import { requireUser } from "@/app/lib/auth";
import { getFeatureDisabledApiResponse } from "@/app/lib/feature-flags";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const getHandler = async function GET() {
  await requireUser();
  const disabledResponse = await getFeatureDisabledApiResponse("agents_dashboard");
  if (disabledResponse) {
    return disabledResponse;
  }

  const [summary, errors, topics, tools] = await Promise.all([
    query(
      `SELECT day, bot_id, bot_name, total_sessions, avg_turns,
              resolved, escalated, abandoned, unique_users, test_sessions
       FROM mv_copilot_summary
       ORDER BY day DESC
       LIMIT 90`
    ),
    query(
      `SELECT COUNT(*)::int AS count FROM copilot_errors
       WHERE error_ts > now() - interval '90 days'`
    ),
    query(
      `SELECT topic_name, avg_duration_sec, median_duration_sec,
              max_duration_sec, execution_count
       FROM copilot_topic_stats
       ORDER BY avg_duration_sec DESC
       LIMIT 10`
    ),
    query(
      `SELECT tool_name, tool_type, total_calls, successful_calls,
              failed_calls, success_rate, avg_duration_sec,
              p50_duration_sec, p95_duration_sec
       FROM copilot_tool_stats
       ORDER BY avg_duration_sec DESC
       LIMIT 10`
    ),
  ]);

  return NextResponse.json({ summary, errors: errors[0], topics, tools });
};

export const GET = withApiRequestTiming("/api/agents", getHandler);
