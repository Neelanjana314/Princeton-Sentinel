import AdminJobControlNotice from "@/app/admin/AdminJobControlNotice";
import { getAdminJobControlState } from "@/app/admin/job-control";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { deriveJobStatus, formatJobTypeLabel, getJobStatusBadgeClass, getJobStatusLabel } from "@/app/admin/job-status";
import CsrfHiddenInput from "@/components/csrf-hidden-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import LocalDateTime from "@/components/local-date-time";

async function JobsPage() {
  await requireAdmin();
  const adminJobControl = await getAdminJobControlState();
  const csrfToken = await getCsrfRenderToken();
  const readOnly = !adminJobControl.jobControlEnabled;

  const rows = await query<any>(
    `
    SELECT j.job_id,
           j.job_type,
           s.schedule_id,
           s.cron_expr,
           s.next_run_at,
           s.enabled AS schedule_enabled,
           m.status AS latest_run_status
    FROM jobs j
    LEFT JOIN job_schedules s ON s.job_id = j.job_id
    LEFT JOIN LATERAL (
      SELECT status
      FROM job_runs r
      WHERE r.job_id = j.job_id
      ORDER BY r.started_at DESC NULLS LAST, r.run_id DESC
      LIMIT 1
    ) m ON true
    ORDER BY j.job_type
    `
  );

  const uniqueJobs = Array.from(new Map(rows.map((row) => [row.job_id, row])).values()).sort((a, b) =>
    (a.job_type || "").localeCompare(b.job_type || "")
  );
  const unscheduledJobs = uniqueJobs.filter((row) => !row.schedule_id);
  const scheduledJobs = uniqueJobs.filter((row) => row.schedule_id);

  return (
    <div className="grid gap-4">
      <AdminJobControlNotice state={adminJobControl} />

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="ps-table">
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
              {rows.map((row) => {
                const status = deriveJobStatus({
                  latestRunStatus: row.latest_run_status,
                  scheduleId: row.schedule_id,
                  scheduleEnabled: row.schedule_enabled,
                  readOnly,
                });
                const hasSchedule = Boolean(row.schedule_id);
                const showPause = hasSchedule && (readOnly || status === "running" || row.schedule_enabled);
                const showResume = hasSchedule && (readOnly || (status !== "running" && !row.schedule_enabled));
                return (
                  <tr key={`${row.job_id}-${row.schedule_id || "none"}`} className="border-t">
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
                          <CsrfHiddenInput token={csrfToken} />
                          <input type="hidden" name="job_id" value={row.job_id} />
                          <input type="hidden" name="redirect_to" value="/admin/jobs" />
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
                            <CsrfHiddenInput token={csrfToken} />
                            <input type="hidden" name="job_id" value={row.job_id} />
                            <input type="hidden" name="redirect_to" value="/admin/jobs" />
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
                            <CsrfHiddenInput token={csrfToken} />
                            <input type="hidden" name="job_id" value={row.job_id} />
                            <input type="hidden" name="redirect_to" value="/admin/jobs" />
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
              {!rows.length ? (
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

      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/schedules" method="post" className="grid gap-3">
              <CsrfHiddenInput token={csrfToken} />
              <input type="hidden" name="action" value="create" />
              <label className="text-sm text-slate">Job</label>
              <select
                name="job_id"
                className="rounded-lg border border-input bg-background p-2 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={readOnly || !unscheduledJobs.length}
                required
              >
                {unscheduledJobs.map((row) => (
                  <option key={row.job_id} value={row.job_id}>
                    {formatJobTypeLabel(row.job_type)}
                  </option>
                ))}
              </select>
              {!unscheduledJobs.length ? (
                <div className="text-xs text-slate">All jobs already have a schedule. Pause or resume existing schedules above.</div>
              ) : null}
              <label className="text-sm text-slate">Cron (5-field)</label>
              <input
                name="cron_expr"
                className="rounded-lg border border-input bg-background p-2 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="*/15 * * * *"
                required
                disabled={readOnly}
              />
              <label className="text-sm text-slate">Next run (optional ISO timestamp)</label>
              <input
                name="next_run_at"
                className="rounded-lg border border-input bg-background p-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="2026-02-02T10:00:00Z"
                disabled={readOnly}
              />
              <button
                className="badge bg-emerald-100 text-emerald-900 disabled:cursor-not-allowed disabled:opacity-70"
                type="submit"
                disabled={readOnly || !unscheduledJobs.length}
              >
                Create Schedule
              </button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Edit Schedule</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form action="/api/schedules" method="post" className="grid gap-3">
              <CsrfHiddenInput token={csrfToken} />
              <input type="hidden" name="action" value="update" />
              <label className="text-sm text-slate">Schedule</label>
              <select
                name="schedule_id"
                className="rounded-lg border border-input bg-background p-2 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={readOnly || !scheduledJobs.length}
                required
              >
                {scheduledJobs.map((row) => (
                  <option key={row.schedule_id} value={row.schedule_id}>
                    {formatJobTypeLabel(row.job_type)} • {row.cron_expr || "--"} • {row.schedule_enabled ? "Enabled" : "Paused"}
                  </option>
                ))}
              </select>
              {!scheduledJobs.length ? <div className="text-xs text-slate">No existing schedules to edit.</div> : null}

              <label className="text-sm text-slate">Cron (5-field)</label>
              <input
                name="cron_expr"
                className="rounded-lg border border-input bg-background p-2 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="*/15 * * * *"
                required
                disabled={readOnly || !scheduledJobs.length}
              />

              <label className="text-sm text-slate">Next run (optional ISO timestamp)</label>
              <input
                name="next_run_at"
                className="rounded-lg border border-input bg-background p-2 text-sm disabled:cursor-not-allowed disabled:opacity-70"
                placeholder="2026-02-02T10:00:00Z"
                disabled={readOnly || !scheduledJobs.length}
              />

              <label className="text-sm text-slate">Schedule Status</label>
              <select
                name="enabled"
                className="rounded-lg border border-input bg-background p-2 disabled:cursor-not-allowed disabled:opacity-70"
                defaultValue=""
                disabled={readOnly || !scheduledJobs.length}
              >
                <option value="">Keep Current</option>
                <option value="true">Enabled</option>
                <option value="false">Paused</option>
              </select>

              <button
                className="badge border-primary/35 bg-primary/15 text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                type="submit"
                disabled={readOnly || !scheduledJobs.length}
              >
                Save Schedule Changes
              </button>
            </form>

            <form action="/api/schedules" method="post" className="grid gap-3">
              <CsrfHiddenInput token={csrfToken} />
              <input type="hidden" name="action" value="delete" />
              <label className="text-sm text-slate">Delete Schedule</label>
              <select
                name="schedule_id"
                className="rounded-lg border border-input bg-background p-2 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={readOnly || !scheduledJobs.length}
                required
              >
                {scheduledJobs.map((row) => (
                  <option key={`delete-${row.schedule_id}`} value={row.schedule_id}>
                    {formatJobTypeLabel(row.job_type)} • {row.cron_expr || "--"}
                  </option>
                ))}
              </select>
              <button
                className="badge badge-error disabled:cursor-not-allowed disabled:opacity-70"
                type="submit"
                disabled={readOnly || !scheduledJobs.length}
              >
                Delete Schedule
              </button>
            </form>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

export default withPageRequestTiming("/admin/jobs", JobsPage);
