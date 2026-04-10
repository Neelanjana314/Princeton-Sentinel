import Link from "next/link";
import { notFound } from "next/navigation";

import { formatJobTypeLabel } from "@/app/admin/job-status";
import { getRunByTypeAndId, getRunLogsByRunId } from "@/app/admin/runs/run-data";
import { requireAdmin } from "@/app/lib/auth";
import { safeDecode } from "@/app/lib/format";
import { withPageRequestTiming } from "@/app/lib/request-timing";
import LocalDateTime from "@/components/local-date-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function statusBadge(status: string) {
  if (status === "success") return "badge badge-ok";
  if (status === "failed") return "badge badge-error";
  return "badge badge-warn";
}

async function RunDetailPage({
  params,
}: {
  params: Promise<{ jobType: string; runId: string }>;
}) {
  await requireAdmin();

  const { jobType: encodedJobType, runId: encodedRunId } = await params;
  const jobType = safeDecode(encodedJobType);
  const runId = safeDecode(encodedRunId);

  if (!UUID_RE.test(runId)) notFound();

  const run = await getRunByTypeAndId(jobType, runId);
  if (!run) notFound();

  const logs = await getRunLogsByRunId(runId);

  return (
    <div className="grid gap-4">
      <div className="text-sm">
        <Link className="text-muted-foreground hover:underline" href={`/admin/runs/${encodeURIComponent(jobType)}`}>
          Back to {formatJobTypeLabel(jobType)} runs
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{formatJobTypeLabel(jobType)} Run</CardTitle>
          <CardDescription>Run details for this execution.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Run ID</div>
            <div className="font-mono text-xs text-foreground">{run.run_id}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Job ID</div>
            <div className="font-mono text-xs text-foreground">{run.job_id}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Status</div>
            <div>
              <span className={statusBadge(run.status)}>{run.status}</span>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Started</div>
            <div className="text-muted-foreground">
              <LocalDateTime value={run.started_at} />
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Finished</div>
            <div className="text-muted-foreground">
              <LocalDateTime value={run.finished_at} />
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Error</div>
            <div className="text-muted-foreground">{run.error || "--"}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run Logs</CardTitle>
          <CardDescription>{logs.length.toLocaleString()} logs (newest first)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="ps-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2">Logged At</th>
                <th className="py-2">Level</th>
                <th className="py-2">Message</th>
                <th className="py-2">Context</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.log_id} className="border-t align-top">
                  <td className="py-3 text-muted-foreground">
                    <LocalDateTime value={log.logged_at} />
                  </td>
                  <td className="py-3">
                    <span className="font-semibold text-foreground">{log.level}</span>
                  </td>
                  <td className="py-3 text-muted-foreground max-w-xl break-words">{log.message}</td>
                  <td className="py-3 text-muted-foreground">
                    {log.context ? (
                      <details>
                        <summary className="cursor-pointer hover:underline">View JSON</summary>
                        <pre className="mt-2 max-w-2xl overflow-x-auto rounded border bg-muted p-2 text-xs text-foreground">
                          {JSON.stringify(log.context, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      "--"
                    )}
                  </td>
                </tr>
              ))}
              {!logs.length ? (
                <tr>
                  <td className="py-8 text-center text-muted-foreground" colSpan={4}>
                    No logs found for this run.
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

export default withPageRequestTiming("/admin/runs/[jobType]/[runId]", RunDetailPage);
