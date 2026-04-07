import { query } from "@/app/lib/db";

export type RevokeLogRow = {
  log_id: number | string;
  occurred_at: string;
  actor_oid: string | null;
  actor_upn: string | null;
  actor_name: string | null;
  drive_id: string | null;
  item_id: string | null;
  permission_id: string | null;
  outcome: "success" | "failed";
  failure_reason: string | null;
  warning: string | null;
  source: string;
  details: Record<string, any> | null;
  item_name: string | null;
  normalized_path: string | null;
  item_web_url: string | null;
};

export type RevokeLogsCursor = {
  occurredAt: string;
  logId: number | string;
};

const REVOKE_LOG_SELECT = `
  SELECT
    l.log_id,
    l.occurred_at,
    l.actor_oid,
    l.actor_upn,
    l.actor_name,
    l.drive_id,
    l.item_id,
    l.permission_id,
    l.outcome,
    l.failure_reason,
    l.warning,
    l.source,
    l.details,
    i.name AS item_name,
    i.normalized_path,
    i.web_url AS item_web_url
  FROM revoke_permission_logs l
  LEFT JOIN msgraph_drive_items i
    ON i.drive_id = l.drive_id
   AND i.id = l.item_id
`;

function clampPositiveInt(value: number, fallback: number, min: number, max: number) {
  const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(normalized, min), max);
}

export function requestedBy(row: RevokeLogRow): string {
  return row.actor_name || row.actor_upn || row.actor_oid || "Unknown";
}

export function itemPath(row: RevokeLogRow): string | null {
  if (!row.normalized_path && !row.item_name) return null;
  if (row.normalized_path && row.item_name) return `${row.normalized_path}/${row.item_name}`;
  return row.normalized_path || row.item_name;
}

export function itemFallback(row: RevokeLogRow): string {
  if (row.drive_id && row.item_id) return `${row.drive_id}::${row.item_id}`;
  return row.item_id || row.drive_id || "Unknown item";
}

export async function getRevokeLogCount(): Promise<number> {
  const rows = await query<{ total: number }>(
    `
    SELECT COUNT(*)::int AS total
    FROM revoke_permission_logs
    `
  );
  return rows[0]?.total || 0;
}

export async function getRevokeLogsPage(pageSize: number, offset: number): Promise<RevokeLogRow[]> {
  const safePageSize = clampPositiveInt(pageSize, 50, 1, 200);
  const safeOffset = clampPositiveInt(offset, 0, 0, 1_000_000_000);

  return query<RevokeLogRow>(
    `
    ${REVOKE_LOG_SELECT}
    ORDER BY l.occurred_at DESC, l.log_id DESC
    LIMIT $1 OFFSET $2
    `,
    [safePageSize, safeOffset]
  );
}

export async function getRevokeLogsBatchAfter(cursor: RevokeLogsCursor | null, batchSize: number): Promise<RevokeLogRow[]> {
  const safeBatchSize = clampPositiveInt(batchSize, 500, 1, 2000);

  if (!cursor) {
    return query<RevokeLogRow>(
      `
      ${REVOKE_LOG_SELECT}
      ORDER BY l.occurred_at DESC, l.log_id DESC
      LIMIT $1
      `,
      [safeBatchSize]
    );
  }

  return query<RevokeLogRow>(
    `
    ${REVOKE_LOG_SELECT}
    WHERE (l.occurred_at, l.log_id) < ($1::timestamptz, $2::bigint)
    ORDER BY l.occurred_at DESC, l.log_id DESC
    LIMIT $3
    `,
    [cursor.occurredAt, cursor.logId, safeBatchSize]
  );
}
