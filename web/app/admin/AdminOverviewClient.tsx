"use client";

import { useEffect, useMemo, useState } from "react";

import AdminJobControlNotice from "@/app/admin/AdminJobControlNotice";
import type { AdminJobControlState } from "@/app/admin/job-control";
import LocalDateTime from "@/components/local-date-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { deriveJobStatus, formatJobTypeLabel, getJobStatusBadgeClass, getJobStatusLabel } from "@/app/admin/job-status";

type WorkerHealth = {
  ok?: boolean;
  db?: boolean;
  scheduler?: {
    running?: boolean;
    last_tick?: string | null;
    last_error?: string | null;
  } | null;
  heartbeat?: {
    last_attempt_at?: string | null;
    last_success_at?: string | null;
    consecutive_failures?: number;
    last_error?: string | null;
    webapp_reachable?: boolean;
  } | null;
};

type WorkerJob = {
  job_id: string;
  job_type?: string | null;
  schedule_id?: string | null;
  cron_expr?: string | null;
  next_run_at?: string | null;
  schedule_enabled?: boolean | null;
  status?: string | null;
  latest_run_status?: string | null;
};

type OverviewResponse = {
  health?: WorkerHealth;
  jobs?: WorkerJob[];
  adminJobControl?: AdminJobControlState;
};

const REFRESH_INTERVAL_MS = 5000;

export default function AdminOverviewClient({ initialAdminJobControl }: { initialAdminJobControl: AdminJobControlState }) {
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [adminJobControl, setAdminJobControl] = useState<AdminJobControlState>(initialAdminJobControl);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const readOnly = !adminJobControl.jobControlEnabled;

  const runningCount = useMemo(
    () =>
      jobs.filter(
        (job) =>
          deriveJobStatus({
            latestRunStatus: job.latest_run_status || job.status,
            scheduleId: job.schedule_id,
            scheduleEnabled: job.schedule_enabled,
            readOnly,
          }) === "running"
      ).length,
    [jobs, readOnly]
  );
  const dbHealthLabel = health ? (health.db ? "Connected" : "Down") : "--";
  const workerHealthLabel = health ? (health.ok ? "Healthy" : "Degraded") : "--";
  const schedulerLabel = health?.scheduler ? (health.scheduler.running ? "Running" : "Stopped") : "--";
  const heartbeatLabel = health?.heartbeat ? (health.heartbeat.webapp_reachable ? "Reachable" : "Unreachable") : "--";

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const res = await fetch("/api/worker/overview", { cache: "no-store" });
        const text = await res.text();
        let payload: OverviewResponse = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          throw new Error("Invalid overview response");
        }
        if (!res.ok) {
          const errorMessage =
            (payload as any)?.error || (payload as any)?.health_error || (payload as any)?.jobs_error || `HTTP ${res.status}`;
          throw new Error(String(errorMessage));
        }
        if (cancelled) return;
        setHealth(payload.health || null);
        setJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
        setAdminJobControl(payload.adminJobControl || initialAdminJobControl);
        setLastUpdatedAt(new Date().toLocaleString());
        setRefreshError(null);
      } catch (err: any) {
        if (cancelled) return;
        setRefreshError(err?.message || "Failed to refresh");
      }
    }

    refresh();
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="grid gap-4">
      <AdminJobControlNotice state={adminJobControl} />

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

      <Card>
        <CardHeader>
          <CardTitle>Component Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="text-sm text-slate">DB Health</div>
              <div className="mt-1 text-lg font-semibold text-ink">{dbHealthLabel}</div>
              <div className="mt-2 text-xs text-slate">Connection probe from worker /health</div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="text-sm text-slate">Worker Health</div>
              <div className="mt-1 text-lg font-semibold text-ink">{workerHealthLabel}</div>
              <div className="mt-2 text-xs text-slate">
                Scheduler: {schedulerLabel} • Heartbeat: {heartbeatLabel}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="text-sm text-slate">Worker Last Seen</div>
              <div className="mt-1 text-xs text-slate">
                <LocalDateTime value={health?.heartbeat?.last_success_at} fallback="Never" />
              </div>
              <div className="mt-2 text-xs text-slate">
                Last attempt: <LocalDateTime value={health?.heartbeat?.last_attempt_at} fallback="Never" />
              </div>
              <div className="mt-1 text-xs text-slate">
                Consecutive failures: {health?.heartbeat?.consecutive_failures ?? 0}
              </div>
              <div className="mt-1 text-xs text-slate truncate" title={health?.heartbeat?.last_error || ""}>
                Last error: {health?.heartbeat?.last_error || "--"}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run Controls</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate/70">
              <tr>
                <th className="py-2">Job</th>
                <th className="py-2">Job Status</th>
                <th className="py-2">Schedule</th>
                <th className="py-2">Next Run</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((row) => {
                const status = deriveJobStatus({
                  latestRunStatus: row.latest_run_status || row.status,
                  scheduleId: row.schedule_id,
                  scheduleEnabled: row.schedule_enabled,
                  readOnly,
                });
                const hasSchedule = Boolean(row.schedule_id);
                const showPause = hasSchedule && (readOnly || Boolean(row.schedule_enabled));
                const showResume = hasSchedule && (readOnly || !row.schedule_enabled);
                return (
                  <tr key={`${row.job_id}-${row.schedule_id || "none"}`} className="border-t border-white/60">
                    <td className="py-3 font-semibold text-ink">{formatJobTypeLabel(row.job_type)}</td>
                    <td className="py-3">
                      <span className={getJobStatusBadgeClass(status)}>{getJobStatusLabel(status)}</span>
                    </td>
                    <td className="py-3 text-slate">{row.cron_expr || "--"}</td>
                    <td className="py-3 text-slate">
                      <LocalDateTime value={readOnly ? null : row.schedule_enabled ? row.next_run_at : null} fallback="-" />
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <form action="/api/worker/run-now" method="post">
                          <input type="hidden" name="job_id" value={row.job_id} />
                          <input type="hidden" name="redirect_to" value="/admin" />
                          <button
                            className="badge border-primary/35 bg-primary/15 text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                            type="submit"
                            disabled={readOnly || status === "running"}
                          >
                            {readOnly ? "Run Now" : status === "running" ? "Running..." : "Run Now"}
                          </button>
                        </form>
                        {showPause ? (
                          <form action="/api/worker/pause" method="post">
                            <input type="hidden" name="job_id" value={row.job_id} />
                            <input type="hidden" name="redirect_to" value="/admin" />
                            <button
                              className="badge border border-input bg-background text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                              type="submit"
                              disabled={readOnly}
                            >
                              Pause Schedule
                            </button>
                          </form>
                        ) : null}
                        {showResume ? (
                          <form action="/api/worker/resume" method="post">
                            <input type="hidden" name="job_id" value={row.job_id} />
                            <input type="hidden" name="redirect_to" value="/admin" />
                            <button
                              className="badge bg-emerald-100 text-emerald-900 disabled:cursor-not-allowed disabled:opacity-70"
                              type="submit"
                              disabled={readOnly}
                            >
                              Resume Schedule
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!jobs.length ? (
                <tr>
                  <td className="py-8 text-center text-muted-foreground" colSpan={5}>
                    No jobs found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
