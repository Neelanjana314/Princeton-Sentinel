import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin } from "@/app/lib/auth";
import { getPagination, SearchParams } from "@/app/lib/params";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import LocalDateTime from "@/components/local-date-time";
import { getAgentQuarantineLogCount, getAgentQuarantineLogsPage } from "./agent-quarantine-queries";

async function AgentQuarantinePage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireAdmin();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });

  const total = await getAgentQuarantineLogCount();
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;
  const rows = await getAgentQuarantineLogsPage(pageSize, offset);

  return (
    <div className="grid min-w-0 gap-4">
      <Card className="min-w-0">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Agent Quarantine</CardTitle>
            <CardDescription>
              {total.toLocaleString()} events • showing {rows.length.toLocaleString()}
            </CardDescription>
          </div>
          <Button asChild variant="outline">
            <a href="/api/admin/agent-quarantine/export">Download Logs</a>
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          <form action="/admin/agent-quarantine" method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="page" value="1" />
            <label className="text-sm text-slate" htmlFor="pageSize">Rows per page</label>
            <Input id="pageSize" name="pageSize" type="number" min={10} max={200} defaultValue={String(pageSize)} className="w-24" />
            <Button type="submit" variant="outline">Apply</Button>
          </form>

          <div className="max-w-full overflow-x-auto">
            <table className="ps-table min-w-[1236px] table-fixed">
              <thead className="text-left text-slate/70">
                <tr>
                  <th className="w-[168px] py-2 pr-3">Timestamp</th>
                  <th className="w-[120px] py-2 pr-3">Action</th>
                  <th className="w-[120px] py-2 pr-3">Status</th>
                  <th className="w-[220px] py-2 pr-3">Admin</th>
                  <th className="w-[220px] py-2 pr-3">Agent</th>
                  <th className="w-[220px] py-2 pr-3">Reason</th>
                  <th className="w-[168px] py-2 pr-3">Last Update</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t align-top">
                    <td className="py-3 pr-3 text-slate">
                      <LocalDateTime value={row.occurred_at} />
                    </td>
                    <td className="py-3 pr-3">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                        row.action === "quarantine"
                          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                          : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      }`}>
                        {row.action === "quarantine" ? "Blocked" : "Unblocked"}
                      </span>
                    </td>
                    <td className="py-3 pr-3">
                      <span className={row.request_status === "success" ? "badge badge-ok" : "badge badge-error"}>
                        {row.request_status}
                      </span>
                    </td>
                    <td className="py-3 pr-3 truncate" title={row.actor_name || row.actor_upn || row.actor_oid || "—"}>
                      <div className="truncate font-medium">{row.actor_name || row.actor_upn || row.actor_oid || "—"}</div>
                      {row.actor_name && row.actor_upn ? (
                        <div className="truncate text-[11px] text-slate">{row.actor_upn}</div>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 truncate" title={row.bot_name || row.bot_id}>
                      <div className="truncate font-medium">{row.bot_name || row.bot_id}</div>
                      <div className="truncate text-[11px] text-slate">{row.bot_id}</div>
                    </td>
                    <td className="py-3 pr-3 text-slate">
                      <div className="truncate" title={row.reason || "—"}>
                        {row.reason || "—"}
                      </div>
                    </td>
                    <td className="py-3 pr-3 text-slate">
                      <LocalDateTime value={row.result_last_update_time_utc} fallback="—" />
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td className="py-8 text-center text-muted-foreground" colSpan={7}>
                      No agent quarantine events found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Pagination pathname="/admin/agent-quarantine" page={clampedPage} pageSize={pageSize} totalItems={total} extraParams={{ pageSize }} />
    </div>
  );
}

export default withPageRequestTiming("/admin/agent-quarantine", AgentQuarantinePage);
