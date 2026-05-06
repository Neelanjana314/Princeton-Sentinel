import { query } from "@/app/lib/db";
import LocalDateTime from "@/components/local-date-time";
import { cn } from "@/lib/utils";

export type DataRefreshJobType = "graph_ingest" | "copilot_usage_sync" | "copilot_telemetry";

type DataRefreshTimestampProps = {
  sourceLabel: string;
  finishedAt: string | null;
  className?: string;
};

export async function getLatestDataRefreshFinishedAt(jobType: DataRefreshJobType) {
  const rows = await query<{ finished_at: string | Date | null }>(
    `
    SELECT r.finished_at
    FROM job_runs r
    JOIN jobs j ON j.job_id = r.job_id
    WHERE j.job_type = $1
      AND r.finished_at IS NOT NULL
      AND r.status = 'success'
    ORDER BY r.finished_at DESC
    LIMIT 1
    `,
    [jobType]
  );

  const value = rows[0]?.finished_at;
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export default function DataRefreshTimestamp({ sourceLabel, finishedAt, className }: DataRefreshTimestampProps) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card px-3 py-2 text-right text-xs text-muted-foreground shadow-sm",
        className
      )}
      aria-label={`${sourceLabel} data refresh timestamp`}
    >
      <span className="font-medium text-foreground">{sourceLabel}</span>
      <span> data refreshed at </span>
      {finishedAt ? (
        <LocalDateTime value={finishedAt} />
      ) : (
        <span>No successful refresh yet</span>
      )}
    </div>
  );
}
