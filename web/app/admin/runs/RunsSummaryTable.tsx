"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatJobTypeLabel } from "@/app/admin/job-status";
import type { RunRow } from "@/app/admin/runs/run-data";
import { formatDate } from "@/app/lib/format";

function statusBadge(status: string) {
  if (status === "success") return "badge badge-ok";
  if (status === "failed") return "badge badge-error";
  return "badge badge-warn";
}

export default function RunsSummaryTable({ initialRuns }: { initialRuns: RunRow[] }) {
  const [runs, setRuns] = useState<RunRow[]>(initialRuns || []);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const runningCount = useMemo(() => runs.filter((r) => r.status === "running").length, [runs]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch("/api/runs/summary", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setRuns(Array.isArray(data?.runs) ? data.runs : []);
        setLastUpdatedAt(new Date().toLocaleString());
        setRefreshError(null);
      } catch (err: any) {
        if (cancelled) return;
        setRefreshError(err?.message || "Failed to refresh");
      }
    }

    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div>
          <span className="font-semibold text-foreground">Live</span>: refreshes every 5s
          {runningCount ? ` • ${runningCount} running` : ""}
        </div>
        <div className="text-right">
          {refreshError ? (
            <span className="text-red-700">Refresh failed: {refreshError}</span>
          ) : lastUpdatedAt ? (
            <span>Updated {lastUpdatedAt}</span>
          ) : (
            <span />
          )}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="ps-table">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Job</th>
              <th className="py-2">Status</th>
              <th className="py-2">Started</th>
              <th className="py-2">Finished</th>
              <th className="py-2">Latest log</th>
              <th className="py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.run_id}
                className={run.status === "running" ? "border-t bg-amber-100/40 dark:bg-amber-900/20" : "border-t"}
              >
                <td className="py-3 text-foreground font-semibold">
                  {run.job_type ? (
                    <Link className="hover:underline" href={`/admin/runs/${encodeURIComponent(run.job_type)}`}>
                      {formatJobTypeLabel(run.job_type)}
                    </Link>
                  ) : (
                    run.job_id
                  )}
                </td>
                <td className="py-3">
                  <span className={statusBadge(run.status)}>{run.status}</span>
                </td>
                <td className="py-3 text-muted-foreground">{formatDate(run.started_at)}</td>
                <td className="py-3 text-muted-foreground">{formatDate(run.finished_at)}</td>
                <td className="py-3 text-muted-foreground max-w-xs truncate" title={run.last_log_message || ""}>
                  {run.last_log_message ? (
                    <>
                      <span className="font-semibold text-foreground">{run.last_log_level}</span>{" "}
                      <span className="text-muted-foreground">{run.last_log_message}</span>{" "}
                      <span className="text-muted-foreground/70">({formatDate(run.last_log_at)})</span>
                    </>
                  ) : (
                    "--"
                  )}
                </td>
                <td className="py-3 text-muted-foreground max-w-xs truncate" title={run.error || ""}>
                  {run.error || "--"}
                </td>
              </tr>
            ))}
            {!runs.length ? (
              <tr>
                <td className="py-8 text-center text-muted-foreground" colSpan={6}>
                  No runs found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
