import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin } from "@/app/lib/auth";
import { getPagination, SearchParams } from "@/app/lib/params";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import LocalDateTime from "@/components/local-date-time";
import { getAgentAccessLogCount, getAgentAccessLogsPage } from "./agent-access-log-queries";

async function AgentAccessLogsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireAdmin();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });

  const total = await getAgentAccessLogCount();
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;
  const rows = await getAgentAccessLogsPage(pageSize, offset);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Agent Access Logs</CardTitle>
            <CardDescription>
              {total.toLocaleString()} events • showing {rows.length.toLocaleString()}
            </CardDescription>
          </div>
          <Button asChild variant="outline">
            <a href="/api/admin/agent-access-logs/export">Download Logs</a>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <form action="/admin/agent-access-logs" method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="page" value="1" />
            <label className="text-sm text-slate" htmlFor="pageSize">Rows per page</label>
            <Input id="pageSize" name="pageSize" type="number" min={10} max={200} defaultValue={String(pageSize)} className="w-24" />
            <Button type="submit" variant="outline">Apply</Button>
          </form>

          <table className="ps-table table-fixed">
            <thead className="text-left text-slate/70">
              <tr>
                <th className="w-[168px] py-2 pr-3">Timestamp</th>
                <th className="w-[96px] py-2 pr-3">Action</th>
                <th className="w-[200px] py-2 pr-3">Admin</th>
                <th className="w-[160px] py-2 pr-3">Agent</th>
                <th className="w-[200px] py-2 pr-3">User</th>
                <th className="py-2">Reason</th>
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
                      row.action === "block"
                        ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                    }`}>
                      {row.action === "block" ? "Blocked" : "Unblocked"}
                    </span>
                  </td>
                  <td className="py-3 pr-3 truncate" title={row.admin_name || row.admin_upn || "—"}>
                    <div className="truncate font-medium">{row.admin_name || row.admin_upn || "—"}</div>
                    {row.admin_name && row.admin_upn && (
                      <div className="truncate text-[11px] text-slate">{row.admin_upn}</div>
                    )}
                  </td>
                  <td className="py-3 pr-3 truncate" title={row.bot_name || row.bot_id}>
                    <div className="truncate font-medium">{row.bot_name || row.bot_id}</div>
                    <div className="truncate text-[11px] text-slate">{row.bot_id}</div>
                  </td>
                  <td className="py-3 pr-3 truncate" title={row.user_name || row.user_email || row.user_id}>
                    <div className="truncate font-medium">{row.user_name || row.user_email || row.user_id}</div>
                    {row.user_email && (
                      <div className="truncate text-[11px] text-slate">{row.user_email}</div>
                    )}
                  </td>
                  <td className="py-3 text-slate">
                    <div className="truncate" title={row.reason || "—"}>{row.reason || "—"}</div>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td className="py-8 text-center text-muted-foreground" colSpan={6}>
                    No agent access events found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Pagination pathname="/admin/agent-access-logs" page={clampedPage} pageSize={pageSize} totalItems={total} extraParams={{ pageSize }} />
    </div>
  );
}

export default withPageRequestTiming("/admin/agent-access-logs", AgentAccessLogsPage);
