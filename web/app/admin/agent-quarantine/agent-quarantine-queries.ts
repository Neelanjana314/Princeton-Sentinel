import { query } from "@/app/lib/db";

export type AgentQuarantineLogRow = {
  id: number;
  occurred_at: string;
  action: "quarantine" | "unquarantine";
  request_status: string;
  actor_oid: string | null;
  actor_upn: string | null;
  actor_name: string | null;
  bot_id: string;
  bot_name: string | null;
  reason: string | null;
  resulting_is_quarantined: boolean | null;
  result_last_update_time_utc: string | null;
  error_detail: string | null;
  details: Record<string, any> | null;
};

export type AgentQuarantineLogCursor = {
  occurredAt: string;
  id: number;
};

function clampPositiveInt(value: number, fallback: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

export async function getAgentQuarantineLogCount(): Promise<number> {
  const rows = await query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM agent_quarantine_log`
  );
  return rows[0]?.total || 0;
}

export async function getAgentQuarantineLogsPage(pageSize: number, offset: number): Promise<AgentQuarantineLogRow[]> {
  const safePageSize = clampPositiveInt(pageSize, 50, 1, 200);
  const safeOffset = clampPositiveInt(offset, 0, 0, 1_000_000_000);

  return query<AgentQuarantineLogRow>(
    `SELECT id, occurred_at, action, request_status, actor_oid, actor_upn, actor_name,
            bot_id, bot_name, reason, resulting_is_quarantined, result_last_update_time_utc,
            error_detail, details
     FROM agent_quarantine_log
     ORDER BY occurred_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [safePageSize, safeOffset]
  );
}

export async function getAgentQuarantineLogsBatchAfter(
  cursor: AgentQuarantineLogCursor | null,
  batchSize: number
): Promise<AgentQuarantineLogRow[]> {
  const safeBatchSize = clampPositiveInt(batchSize, 500, 1, 2000);

  if (!cursor) {
    return query<AgentQuarantineLogRow>(
      `SELECT id, occurred_at, action, request_status, actor_oid, actor_upn, actor_name,
              bot_id, bot_name, reason, resulting_is_quarantined, result_last_update_time_utc,
              error_detail, details
       FROM agent_quarantine_log
       ORDER BY occurred_at DESC, id DESC
       LIMIT $1`,
      [safeBatchSize]
    );
  }

  return query<AgentQuarantineLogRow>(
    `SELECT id, occurred_at, action, request_status, actor_oid, actor_upn, actor_name,
            bot_id, bot_name, reason, resulting_is_quarantined, result_last_update_time_utc,
            error_detail, details
     FROM agent_quarantine_log
     WHERE (occurred_at, id) < ($1::timestamptz, $2::bigint)
     ORDER BY occurred_at DESC, id DESC
     LIMIT $3`,
    [cursor.occurredAt, cursor.id, safeBatchSize]
  );
}
