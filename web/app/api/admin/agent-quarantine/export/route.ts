import { requireAdmin } from "@/app/lib/auth";
import { toCsvRow } from "@/app/lib/csv";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import {
  getAgentQuarantineLogsBatchAfter,
  type AgentQuarantineLogCursor,
  type AgentQuarantineLogRow,
} from "@/app/admin/agent-quarantine/agent-quarantine-queries";

export const dynamic = "force-dynamic";

const CSV_HEADERS = [
  "id",
  "occurred_at",
  "action",
  "request_status",
  "actor_name",
  "actor_upn",
  "actor_oid",
  "bot_id",
  "bot_name",
  "reason",
  "resulting_is_quarantined",
  "result_last_update_time_utc",
  "error_detail",
  "details",
] as const;

const EXPORT_BATCH_SIZE = 1000;

function toExportCsvRow(row: AgentQuarantineLogRow): string {
  return toCsvRow([
    row.id,
    row.occurred_at,
    row.action,
    row.request_status,
    row.actor_name,
    row.actor_upn,
    row.actor_oid,
    row.bot_id,
    row.bot_name,
    row.reason,
    row.resulting_is_quarantined,
    row.result_last_update_time_utc,
    row.error_detail,
    row.details ? JSON.stringify(row.details) : null,
  ]);
}

const getHandler = async function GET() {
  await requireAdmin();

  const encoder = new TextEncoder();
  const now = new Date();
  const filenameDate = now.toISOString().slice(0, 16).replace("T", "_").replace(":", "-");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(toCsvRow([...CSV_HEADERS]) + "\n"));

        let cursor: AgentQuarantineLogCursor | null = null;
        while (true) {
          const rows = await getAgentQuarantineLogsBatchAfter(cursor, EXPORT_BATCH_SIZE);
          if (!rows.length) break;

          const chunk = rows.map((row) => toExportCsvRow(row)).join("\n") + "\n";
          controller.enqueue(encoder.encode(chunk));

          const lastRow = rows[rows.length - 1];
          cursor = { occurredAt: lastRow.occurred_at, id: lastRow.id };
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="agent-quarantine-${filenameDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};

export const GET = withApiRequestTiming("/api/admin/agent-quarantine/export", getHandler);
