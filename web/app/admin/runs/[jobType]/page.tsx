import Link from "next/link";

import { formatJobTypeLabel } from "@/app/admin/job-status";
import { getRunsByTypePage } from "@/app/admin/runs/run-data";
import { requireAdmin } from "@/app/lib/auth";
import { safeDecode } from "@/app/lib/format";
import { getPagination, SearchParams } from "@/app/lib/params";
import { withPageRequestTiming } from "@/app/lib/request-timing";
import { Pagination } from "@/components/pagination";
import LocalDateTime from "@/components/local-date-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusBadge(status: string) {
  if (status === "success") return "badge badge-ok";
  if (status === "failed") return "badge badge-error";
  return "badge badge-warn";
}

async function RunsByTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ jobType: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  await requireAdmin();

  const { jobType: encodedJobType } = await params;
  const jobType = safeDecode(encodedJobType);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 100 });
  const { runs, total } = await getRunsByTypePage(jobType, page, pageSize);

  return (
    <div className="grid gap-4">
      <div className="text-sm">
        <Link className="text-muted-foreground hover:underline" href="/admin/runs">
          Back to latest runs
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{formatJobTypeLabel(jobType)} Runs</CardTitle>
          <CardDescription>
            {total.toLocaleString()} runs • showing {runs.length.toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="ps-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2">Run ID</th>
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
                  <td className="py-3 font-mono text-xs text-foreground">
                    <Link className="hover:underline" href={`/admin/runs/${encodeURIComponent(jobType)}/${encodeURIComponent(run.run_id)}`}>
                      {run.run_id}
                    </Link>
                  </td>
                  <td className="py-3">
                    <span className={statusBadge(run.status)}>{run.status}</span>
                  </td>
                  <td className="py-3 text-muted-foreground">
                    <LocalDateTime value={run.started_at} />
                  </td>
                  <td className="py-3 text-muted-foreground">
                    <LocalDateTime value={run.finished_at} />
                  </td>
                  <td className="py-3 text-muted-foreground max-w-xs truncate" title={run.last_log_message || ""}>
                    {run.last_log_message ? (
                      <>
                        <span className="font-semibold text-foreground">{run.last_log_level}</span>{" "}
                        <span className="text-muted-foreground">{run.last_log_message}</span>{" "}
                        <span className="text-muted-foreground/70">
                          (<LocalDateTime value={run.last_log_at} />)
                        </span>
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
                    No runs found for this job type.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Pagination
        pathname={`/admin/runs/${encodeURIComponent(jobType)}`}
        page={page}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ pageSize }}
      />
    </div>
  );
}

export default withPageRequestTiming("/admin/runs/[jobType]", RunsByTypePage);
