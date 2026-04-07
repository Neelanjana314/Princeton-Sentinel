import {
  getRevokeLogsBatchAfter,
  itemFallback,
  itemPath,
  requestedBy,
  type RevokeLogRow,
  type RevokeLogsCursor,
} from "@/app/admin/revoke-activity/revoke-activity-queries";
import { requireAdmin } from "@/app/lib/auth";
import { toCsvRow } from "@/app/lib/csv";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const CSV_HEADERS = [
  "log_id",
  "occurred_at",
  "requested_by",
  "actor_name",
  "actor_upn",
  "actor_oid",
  "drive_id",
  "item_id",
  "permission_id",
  "outcome",
  "failure_reason",
  "warning",
  "source",
  "item_name",
  "normalized_path",
  "item_path",
  "item_web_url",
  "details_json",
] as const;

const EXPORT_BATCH_SIZE = 1000;

function toExportCsvRow(row: RevokeLogRow): string {
  const displayItemPath = itemPath(row) || itemFallback(row);
  const detailsJson = row.details == null ? "" : JSON.stringify(row.details);

  return toCsvRow([
    row.log_id,
    row.occurred_at,
    requestedBy(row),
    row.actor_name,
    row.actor_upn,
    row.actor_oid,
    row.drive_id,
    row.item_id,
    row.permission_id,
    row.outcome,
    row.failure_reason,
    row.warning,
    row.source,
    row.item_name,
    row.normalized_path,
    displayItemPath,
    row.item_web_url,
    detailsJson,
  ]);
}

const getHandler = async function GET() {
  await requireAdmin();

  const encoder = new TextEncoder();
  const filenameDate = new Date().toISOString().slice(0, 10);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(toCsvRow([...CSV_HEADERS]) + "\n"));

        let cursor: RevokeLogsCursor | null = null;
        while (true) {
          const rows = await getRevokeLogsBatchAfter(cursor, EXPORT_BATCH_SIZE);
          if (!rows.length) break;

          const chunk = rows.map((row) => toExportCsvRow(row)).join("\n") + "\n";
          controller.enqueue(encoder.encode(chunk));

          const lastRow = rows[rows.length - 1];
          cursor = { occurredAt: lastRow.occurred_at, logId: lastRow.log_id };
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="revoke-activity-logs-${filenameDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};

export const GET = withApiRequestTiming("/api/admin/revoke-logs/export", getHandler);
